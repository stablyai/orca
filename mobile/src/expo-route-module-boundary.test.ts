import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, extname, join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const appDirectory = fileURLToPath(new URL('../app', import.meta.url))
const routeSourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx'])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : [path]
  })
}

function isNonScreenExpoModule(path: string): boolean {
  const fileName = basename(path)
  if (/\+api\.[jt]sx?$/.test(fileName)) {
    return true
  }
  return (
    dirname(relative(appDirectory, path)) === '.' &&
    /^\+(?:html|middleware|native-intent)\.[jt]sx?$/.test(fileName)
  )
}

function isPlatformSpecificApiRoute(path: string): boolean {
  return /\+api\.(?:android|ios|native|web)\.[jt]sx?$/.test(basename(path))
}

function hasDefaultExport(path: string, source: string): boolean {
  const extension = extname(path)
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    extension === '.jsx'
      ? ts.ScriptKind.JSX
      : extension === '.js'
        ? ts.ScriptKind.JS
        : extension === '.tsx'
          ? ts.ScriptKind.TSX
          : ts.ScriptKind.TS
  )

  return sourceFile.statements.some((statement) => {
    if (ts.isExportAssignment(statement)) {
      return !statement.isExportEquals
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause) {
      if (ts.isNamespaceExport(statement.exportClause)) {
        return statement.exportClause.name.text === 'default'
      }
      return statement.exportClause.elements.some(
        (element) => !element.isTypeOnly && element.name.text === 'default'
      )
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    return (
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) !== true &&
      modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true &&
      modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    )
  })
}

function isInvalidRouteModule(path: string, source: string): boolean {
  return (
    isPlatformSpecificApiRoute(path) ||
    (!isNonScreenExpoModule(path) && !hasDefaultExport(path, source))
  )
}

describe('Expo route module boundary', () => {
  it('allows Expo modules that are not screen routes', () => {
    expect(isNonScreenExpoModule(join(appDirectory, 'health+api.ts'))).toBe(true)
    expect(isNonScreenExpoModule(join(appDirectory, 'health+api.ios.ts'))).toBe(false)
    expect(isNonScreenExpoModule(join(appDirectory, '+html.tsx'))).toBe(true)
    expect(isNonScreenExpoModule(join(appDirectory, '+middleware.ts'))).toBe(true)
    expect(isNonScreenExpoModule(join(appDirectory, '+native-intent.ts'))).toBe(true)
    expect(isNonScreenExpoModule(join(appDirectory, 'nested', '+middleware.ts'))).toBe(false)
  })

  it('recognizes syntax-level default exports', () => {
    expect(hasDefaultExport('route.tsx', 'export default function Route() {}')).toBe(true)
    expect(
      hasDefaultExport('route.jsx', 'export default function Route() { return <View /> }')
    ).toBe(true)
    expect(hasDefaultExport('route.ts', "export { default } from './route-screen'")).toBe(true)
    expect(hasDefaultExport('route.ts', "export { Route as default } from './route-screen'")).toBe(
      true
    )
    expect(hasDefaultExport('support.ts', '// export default')).toBe(false)
    expect(hasDefaultExport('support.ts', "const marker = 'export default'")).toBe(false)
    expect(hasDefaultExport('support.ts', 'export default interface Support {}')).toBe(false)
    expect(
      hasDefaultExport('support.ts', "export type { Support as default } from './types'")
    ).toBe(false)
  })

  it('rejects platform-specific API routes even with a default export', () => {
    expect(isPlatformSpecificApiRoute(join(appDirectory, 'health+api.ts'))).toBe(false)
    for (const platform of ['android', 'ios', 'native', 'web']) {
      const path = join(appDirectory, `health+api.${platform}.ts`)
      expect(isInvalidRouteModule(path, 'export default function Route() {}')).toBe(true)
    }
  })

  it('keeps support modules outside the app route directory', () => {
    const invalidRoutes = sourceFiles(appDirectory)
      .filter((path) => routeSourceExtensions.has(extname(path)))
      .filter((path) => isInvalidRouteModule(path, readFileSync(path, 'utf8')))
      .map((path) => relative(appDirectory, path))

    expect(invalidRoutes).toEqual([])
  })
})
