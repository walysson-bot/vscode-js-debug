/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Parser } from 'acorn';
import { generate } from 'astring';
import { promises as fsPromises } from 'fs';
import { NullablePosition, Position, SourceMapConsumer, SourceMapGenerator } from 'source-map';
import * as ts from 'typescript';
import { LineColumn } from '../adapter/breakpoints/breakpointBase';
import { LocalFsUtils } from './fsUtils';
import { Hasher } from './hash';
import { isWithinAsar } from './pathUtils';
import { SourceMap } from './sourceMaps/sourceMap';

export async function prettyPrintAsSourceMap(
  fileName: string,
  minified: string,
  compiledPath: string,
  sourceMapUrl: string,
): Promise<SourceMap | undefined> {
  const ast = Parser.parse(minified, { locations: true, ecmaVersion: 2020 });
  const sourceMap = new SourceMapGenerator({ file: fileName });

  // provide a fake SourceMapGenerator since we want to actually add the
  // *reversed* mappings -- we're creating a fake 'original' source.
  const beautified = generate(ast, {
    sourceMap: {
      setSourceContent: (file, content) => sourceMap.setSourceContent(file, content),
      applySourceMap: (smc, file, path) => sourceMap.applySourceMap(smc, file, path),
      toJSON: () => sourceMap.toJSON(),
      toString: () => sourceMap.toString(),
      addMapping: mapping =>
        sourceMap.addMapping({
          generated: mapping.original,
          original: { column: mapping.generated.column, line: mapping.generated.line },
          source: fileName,
          name: mapping.name,
        }),
    },
  });

  sourceMap.setSourceContent(fileName, beautified);

  return new SourceMap(
    await SourceMapConsumer.fromSourceMap(sourceMap),
    {
      sourceMapUrl,
      compiledPath,
    },
    '',
    [fileName],
  );
}

export function rewriteTopLevelAwait(code: string): string | undefined {
  // Basic idea is to wrap code in async function, which
  // we can await and expose side-effects outside of the function.
  // See "rewriteTopLevelAwait" test for examples.
  code = '(async () => {' + code + '\n})()';
  let body: ts.Block;
  try {
    const sourceFile = ts.createSourceFile(
      'file.js',
      code,
      ts.ScriptTarget.ESNext,
      /*setParentNodes */ true,
    );
    // eslint-disable-next-line
    body = (sourceFile.statements[0] as any)['expression']['expression']['expression'][
      'body'
    ] as ts.Block;
  } catch (e) {
    return;
  }

  const changes: { start: number; end: number; text: string }[] = [];
  let containsAwait = false;
  let containsReturn = false;

  function traverse(node: ts.Node) {
    switch (node.kind) {
      case ts.SyntaxKind.ClassDeclaration:
        // Expose "class Foo" as "Foo=class Foo"
        const cd = node as ts.ClassDeclaration;
        if (cd.parent === body && cd.name)
          changes.push({ text: cd.name.text + '=', start: cd.pos, end: cd.pos });
        break;
      case ts.SyntaxKind.FunctionDeclaration:
        // Expose "function foo(..." as "foo=function foo(..."
        const fd = node as ts.FunctionDeclaration;
        if (fd.name) changes.push({ text: fd.name.text + '=', start: fd.pos, end: fd.pos });
        return;
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.MethodDeclaration:
        // Do not recurse into functions.
        return;
      case ts.SyntaxKind.AwaitExpression:
        containsAwait = true;
        break;
      case ts.SyntaxKind.ForOfStatement:
        if ((node as ts.ForOfStatement).awaitModifier) containsAwait = true;
        break;
      case ts.SyntaxKind.ReturnStatement:
        containsReturn = true;
        break;
      case ts.SyntaxKind.VariableDeclarationList:
        // Expose "var foo=..." as void(foo=...)
        const vd = node as ts.VariableDeclarationList;

        let s = code.substr(vd.pos);
        let skip = 0;
        while (skip < s.length && /^\s$/.test(s[skip])) ++skip;
        s = s.substring(skip);
        const dec = s.startsWith('const') ? 'const' : s.substr(0, 3);
        const vdpos = vd.pos + skip;

        if (vd.parent.kind === ts.SyntaxKind.ForOfStatement) break;
        if (!vd.declarations.length) break;
        if (dec !== 'var') {
          // Do not expose "for (const|let foo".
          if (vd.parent.kind !== ts.SyntaxKind.VariableStatement || vd.parent.parent !== body)
            break;
        }
        const onlyOneDeclaration = vd.declarations.length === 1;
        changes.push({
          text: onlyOneDeclaration ? 'void' : 'void (',
          start: vdpos,
          end: vdpos + dec.length,
        });
        for (const declaration of vd.declarations) {
          if (!declaration.initializer) {
            changes.push({ text: '(', start: declaration.pos, end: declaration.pos });
            changes.push({ text: '=undefined)', start: declaration.end, end: declaration.end });
            continue;
          }
          changes.push({ text: '(', start: declaration.pos, end: declaration.pos });
          changes.push({ text: ')', start: declaration.end, end: declaration.end });
        }
        if (!onlyOneDeclaration) {
          const last = vd.declarations[vd.declarations.length - 1];
          changes.push({ text: ')', start: last.end, end: last.end });
        }
        break;
    }
    ts.forEachChild(node, traverse);
  }
  traverse(body);

  // Top-level return is not allowed.
  if (!containsAwait || containsReturn) return;

  // If we expect the value (last statement is an expression),
  // return it from the inner function.
  const last = body.statements[body.statements.length - 1];
  if (last.kind === ts.SyntaxKind.ExpressionStatement) {
    changes.push({ text: 'return (', start: last.pos, end: last.pos });
    if (code[last.end - 1] !== ';') changes.push({ text: ')', start: last.end, end: last.end });
    else changes.push({ text: ')', start: last.end - 1, end: last.end - 1 });
  }
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    code = code.substr(0, change.start) + change.text + code.substr(change.end);
  }
  return code;
}

/**
 * If the given code is an object literal expression, like `{ foo: true }`,
 * wraps it with parens like `({ foo: true })`. Will return the input code
 * for other expression or invalid code.
 */
export function wrapObjectLiteral(code: string): string {
  let src: ts.SourceFile;
  try {
    src = ts.createSourceFile('file.js', `return ${code};`, ts.ScriptTarget.ESNext, true);
  } catch {
    return code;
  }
  const returnStmt = src.statements[0];
  if (!ts.isReturnStatement(returnStmt) || !returnStmt.expression) {
    return code; // should never happen, maybe if there's a bizarre parse error
  }

  const diagnostics = ((src as unknown) as { parseDiagnostics?: ts.DiagnosticMessage[] })
    .parseDiagnostics;
  if (diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) {
    return code; // abort on parse errors
  }

  return ts.isObjectLiteralExpression(returnStmt.expression) ? `(${code})` : code;
}

export function parseSourceMappingUrl(content: string): string | undefined {
  if (!content) return;
  const name = 'sourceMappingURL';
  const length = content.length;
  const nameLength = name.length;

  let pos = length;
  let equalSignPos = 0;
  while (true) {
    pos = content.lastIndexOf(name, pos);
    if (pos === -1) return;
    // Check for a /\/[\/*][@#][ \t]/ regexp (length of 4) before found name.
    if (pos < 4) return;
    pos -= 4;
    if (content[pos] !== '/') continue;
    if (content[pos + 1] !== '/') continue;
    if (content[pos + 2] !== '#' && content[pos + 2] !== '@') continue;
    if (content[pos + 3] !== ' ' && content[pos + 3] !== '\t') continue;
    equalSignPos = pos + 4 + nameLength;
    if (equalSignPos < length && content[equalSignPos] !== '=') continue;
    break;
  }

  let sourceMapUrl = content.substring(equalSignPos + 1);
  const newLine = sourceMapUrl.indexOf('\n');
  if (newLine !== -1) sourceMapUrl = sourceMapUrl.substring(0, newLine);
  sourceMapUrl = sourceMapUrl.trim();
  for (let i = 0; i < sourceMapUrl.length; ++i) {
    if (
      sourceMapUrl[i] === '"' ||
      sourceMapUrl[i] === "'" ||
      sourceMapUrl[i] === ' ' ||
      sourceMapUrl[i] === '\t'
    )
      return;
  }
  return sourceMapUrl;
}

const hasher = new Hasher();

export async function checkContentHash(
  absolutePath: string,
  contentHash?: string,
  contentOverride?: string,
): Promise<string | undefined> {
  if (!absolutePath) {
    return undefined;
  }

  if (isWithinAsar(absolutePath)) {
    return undefined;
  }

  if (!contentHash) {
    const exists = await new LocalFsUtils(fsPromises).exists(absolutePath);
    return exists ? absolutePath : undefined;
  }

  const result =
    typeof contentOverride === 'string'
      ? await hasher.verifyBytes(contentOverride, contentHash, true)
      : await hasher.verifyFile(absolutePath, contentHash, true);

  return result ? absolutePath : undefined;
}

export function positionToOffset(text: string, line: number, column: number): number {
  let offset = 0;
  const lines = text.split('\n');
  for (let l = 1; l < line; ++l) offset += lines[l - 1].length + 1;
  offset += column - 1;
  return offset;
}

interface INotNullRange {
  line: number;
  column: number;
  lastColumn: number | null;
}

/**
 * When calling `generatedPositionFor`, we may find non-exact matches. The
 * bias passed to the method controls which of the matches we choose.
 * Here, we will try to pick the position that maps back as closely as
 * possible to the source line if we get an approximate match,
 */
export function getOptimalCompiledPosition(
  sourceUrl: string,
  uiLocation: LineColumn,
  map: SourceMapConsumer,
): NullablePosition {
  const prevLocation = map.generatedPositionFor({
    source: sourceUrl,
    line: uiLocation.lineNumber,
    column: uiLocation.columnNumber - 1, // source map columns are 0-indexed
    bias: SourceMapConsumer.GREATEST_LOWER_BOUND,
  });

  const getVariance = (position: NullablePosition) => {
    if (position.line === null || position.column === null) {
      return 10e10;
    }

    const original = map.originalPositionFor(position as Position);
    return original.line !== null ? Math.abs(uiLocation.lineNumber - original.line) : 10e10;
  };

  const prevVariance = getVariance(prevLocation);

  // allGeneratedLocations similar to a LEAST_UPPER_BOUND, except that it gets
  // all possible locations. From those, we choose the first-best option.
  const allLocations = map
    .allGeneratedPositionsFor({
      source: sourceUrl,
      line: uiLocation.lineNumber,
      column: uiLocation.columnNumber - 1, // source map columns are 0-indexed
    })
    .filter((loc): loc is INotNullRange => loc.line !== null && loc.column !== null)
    .sort((a, b) => (a.line !== b.line ? a.line - b.line : a.column - b.column))
    .map((position): [INotNullRange, number] => [position, getVariance(position)]);

  allLocations.push([prevLocation as INotNullRange, prevVariance]);

  // Sort again--sort is stable (de facto for a while, formalized in ECMA 2019),
  // so we get the first location that has the least variance, or if the variance is the same, the one that appears earliest.
  allLocations.sort(
    ([a, varA], [b, varB]) => varA - varB || a.line - b.line || a.column - b.column,
  );

  return allLocations[0][0];
}

/**
 * Returns the syntax error in the given code, if any.
 */
export function getSyntaxErrorIn(code: string): Error | void {
  try {
    new Function(code);
  } catch (e) {
    return e;
  }
}
