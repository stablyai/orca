import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// expo-router treats every TypeScript file under `app/` as a route, including non-route modules.
const APP_ROOT = path.resolve(import.meta.dirname, '../app')

function walkRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkRouteFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function hasDefaultExport(source: string): boolean {
  const sourceFile = ts.createSourceFile(
    'route.tsx',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX
  )
  return sourceFile.statements.some((statement) => {
    if (ts.isExportAssignment(statement)) {
      return !statement.isExportEquals
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      return statement.exportClause.elements.some(
        (element) => !element.isTypeOnly && element.name.text === 'default'
      )
    }
    if (!ts.canHaveModifiers(statement)) {
      return false
    }
    const modifiers = ts.getModifiers(statement)
    return (
      modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true &&
      modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    )
  })
}

describe('expo-router route tree', () => {
  it.each([
    ['direct default', 'export default function Route() {}', true],
    ['aliased default', 'const Route = () => null; export { Route as default }', true],
    ['default re-export', "export { default } from './route'", true],
    ['renamed default', "export { default as Route } from './route'", false],
    ['named export', 'export const route = {}', false]
  ])('detects %s syntax', (_label, source, expected) => {
    expect(hasDefaultExport(source)).toBe(expected)
  })

  it('holds only files that export a route component', () => {
    const missing = walkRouteFiles(APP_ROOT)
      .filter((file) => !hasDefaultExport(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(APP_ROOT, file).split(path.sep).join('/'))
      .sort()
    // Why toEqual([]): failures print the exact phantom routes.
    expect(missing).toEqual([])
  })
})
