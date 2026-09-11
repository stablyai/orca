import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Why: src/shared/rpc-contract/*-params.ts hold the host's zod schemas. Bundling one
// into the app would let client code call parse(), and requiredString is
// z.unknown().transform(...) — it coerces a non-string to '' instead of rejecting it,
// silently changing the bytes the phone puts on the wire. Types only, never values.
const mobileRoot = fileURLToPath(new URL('..', import.meta.url))
const contractRoot = resolve(mobileRoot, '..', 'src', 'shared', 'rpc-contract')
const scannedRoots = ['app', 'src'].map((directory) => join(mobileRoot, directory))
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx'])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return [path]
  })
}

function targetsContract(path: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false
  const resolved = resolve(path, '..', specifier)
  return resolved === contractRoot || resolved.startsWith(`${contractRoot}/`)
}

function parse(path: string, source: string): ts.SourceFile {
  const extension = extname(path)
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    extension === '.tsx' || extension === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

// Returns the specifiers that would pull contract *values* into the bundle.
export function contractValueImports(path: string, source: string): string[] {
  const sourceFile = parse(path, source)
  const offenders: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      if (targetsContract(path, specifier)) {
        const clause = node.importClause
        const everyNamedIsType =
          clause?.isTypeOnly === true ||
          (clause?.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly))
        // A bare `import './x'` has no clause at all and still emits a require.
        if (!everyNamedIsType) offenders.push(specifier)
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text
      if (targetsContract(path, specifier)) {
        const everyNamedIsType =
          node.isTypeOnly ||
          (node.exportClause !== undefined &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.every((element) => element.isTypeOnly))
        if (!everyNamedIsType) offenders.push(specifier)
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isDynamic = callee.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
      const argument = node.arguments[0]
      if (
        (isDynamic || isRequire) &&
        argument &&
        ts.isStringLiteral(argument) &&
        targetsContract(path, argument.text)
      ) {
        offenders.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return offenders
}

describe('RPC params contract boundary', () => {
  it('flags every shape that would emit a runtime require', () => {
    const path = join(mobileRoot, 'src', 'probe.ts')
    const contract = '../../src/shared/rpc-contract/repo-params'
    expect(contractValueImports(path, `import { RepoSelector } from '${contract}'`)).toEqual([
      contract
    ])
    expect(contractValueImports(path, `import '${contract}'`)).toEqual([contract])
    expect(contractValueImports(path, `export { RepoSelector } from '${contract}'`)).toEqual([
      contract
    ])
    expect(contractValueImports(path, `const s = require('${contract}')`)).toEqual([contract])
    expect(contractValueImports(path, `const s = await import('${contract}')`)).toEqual([contract])
    expect(contractValueImports(path, `import type { RepoSelector } from '${contract}'`)).toEqual(
      []
    )
    expect(contractValueImports(path, `import { type RepoSelector } from '${contract}'`)).toEqual(
      []
    )
    expect(contractValueImports(path, `export type { RepoSelector } from '${contract}'`)).toEqual(
      []
    )
    expect(
      contractValueImports(
        path,
        `import type { GitHubWorkItem } from '../../src/shared/github/work-item-types'`
      )
    ).toEqual([])
  })

  it('keeps every mobile import of the params contract type-only', () => {
    const offenders = scannedRoots
      .flatMap(sourceFiles)
      .filter((path) => sourceExtensions.has(extname(path)))
      .flatMap((path) =>
        contractValueImports(path, readFileSync(path, 'utf8')).map(
          (specifier) => `${relative(mobileRoot, path)} -> ${specifier}`
        )
      )

    expect(offenders).toEqual([])
  })
})
