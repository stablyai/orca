import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')
const MAIN_ROOT = join(REPO_ROOT, 'src/main')
const WHOLE_DIRECTORIES = ['native-chat', 'acp', 'provider-process']
const PREFIXED_DIRECTORIES = [
  ['claude', ['claude-structured-', 'claude-agent-sdk-']],
  ['codex', ['codex-structured-', 'codex-app-server-']],
  ['runtime', ['structured-agent-session-', 'agent-session-']]
] as const
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

function collectSourceFiles(root: string): string[] {
  if (!existsSync(root)) {
    return []
  }
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = join(root, entry.name)
    if (entry.isDirectory()) {
      return collectSourceFiles(file)
    }
    return EXTENSIONS.some((extension) => file.endsWith(extension)) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
      ? [file]
      : []
  })
}

function structuredChatFiles(): string[] {
  return [
    ...WHOLE_DIRECTORIES.flatMap((directory) => collectSourceFiles(join(MAIN_ROOT, directory))),
    ...PREFIXED_DIRECTORIES.flatMap(([directory, prefixes]) => {
      const root = join(MAIN_ROOT, directory)
      return collectSourceFiles(root).filter((file) =>
        prefixes.some((prefix) => relative(root, file).startsWith(prefix))
      )
    })
  ].sort()
}

// Follow the existing source-boundary AST scanner; prose and string fixtures are not imports.
function collectModuleSpecifiers(source: string, includeTypes = false): string[] {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      let typeOnly = false
      if (ts.isImportDeclaration(node) && node.importClause) {
        const clause = node.importClause
        typeOnly = clause.isTypeOnly
        if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          typeOnly ||=
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((binding) => binding.isTypeOnly)
        }
      } else if (ts.isExportDeclaration(node)) {
        typeOnly = node.isTypeOnly
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          typeOnly ||=
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((binding) => binding.isTypeOnly)
        }
      }
      if (includeTypes || !typeOnly) {
        specifiers.push(node.moduleSpecifier.text)
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      (includeTypes || !node.isTypeOnly) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text)
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return specifiers
}

function resolveSourceImport(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }
  const base = resolve(dirname(file), specifier)
  const extensionless = base.replace(/\.[cm]?[jt]sx?$/, '')
  const candidates = [
    ...(EXTENSIONS.some((extension) => base.endsWith(extension)) ? [base] : []),
    ...EXTENSIONS.map((extension) => `${extensionless}${extension}`),
    ...EXTENSIONS.map((extension) => join(base, `index${extension}`))
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function electronImportChains(
  roots: string[],
  readSource: (file: string) => string,
  resolveImport: (file: string, specifier: string) => string | null
): string[] {
  const rootSet = new Set(roots)
  const pending = roots.map((file) => [file])
  const visited = new Set<string>()
  const offenders: string[] = []
  while (pending.length > 0) {
    const chain = pending.pop()
    const file = chain?.at(-1)
    if (!chain || !file || visited.has(file)) {
      continue
    }
    visited.add(file)
    const source = readSource(file)
    const runtimeSpecifiers = collectModuleSpecifiers(source)
    const specifiers = rootSet.has(file) ? collectModuleSpecifiers(source, true) : runtimeSpecifiers
    for (const specifier of specifiers) {
      if (specifier === 'electron' || specifier.startsWith('electron/')) {
        offenders.push([...chain, specifier].map((step) => relativeLabel(step)).join(' -> '))
        continue
      }
      if (!runtimeSpecifiers.includes(specifier)) {
        continue
      }
      const dependency = resolveImport(file, specifier)
      if (dependency && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(dependency)) {
        pending.push([...chain, dependency])
      }
    }
  }
  return offenders.sort()
}

function relativeLabel(file: string): string {
  return file === 'electron' || file.startsWith('electron/')
    ? file
    : relative(REPO_ROOT, file).split('\\').join('/')
}

describe('structured chat Electron import boundary', () => {
  it('covers the existing lanes even before ACP and provider-process directories exist', () => {
    const files = structuredChatFiles()
    expect(files.length).toBeGreaterThan(300)
    expect(files).toContain(join(MAIN_ROOT, 'native-chat/transcript-native-watcher.ts'))
    for (const [directory, prefixes] of PREFIXED_DIRECTORIES) {
      for (const prefix of prefixes) {
        expect(
          files.some((file) => relative(MAIN_ROOT, file).startsWith(join(directory, prefix)))
        ).toBe(true)
      }
    }
    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false)
  })

  it('detects imports, side effects, re-exports, dynamic imports and require without matching prose', () => {
    const source = [
      "// import 'comment'",
      'const prose = "import \'string\'"',
      "import { app } from 'static'",
      "import 'side-effect'",
      "import {} from 'empty-bindings'",
      "export { app } from 're-export'",
      "export * from 'export-all'",
      "const dynamic = import('dynamic')",
      "const required = require('required')",
      "import imported = require('import-equals')",
      "import type { TypeOnly } from 'type-only'",
      "import { type InlineType } from 'inline-type'",
      "export type { TypeOnly } from 'export-type'"
    ].join('\n')
    expect(collectModuleSpecifiers(source)).toEqual([
      'static',
      'side-effect',
      'empty-bindings',
      're-export',
      'export-all',
      'dynamic',
      'required',
      'import-equals'
    ])
    expect(collectModuleSpecifiers(source, true)).toContain('type-only')
  })

  it('detects an Electron-bound local dependency and terminates on import cycles', () => {
    const root = join(MAIN_ROOT, 'acp/session.ts')
    const dependency = join(MAIN_ROOT, 'desktop-service.ts')
    const sources = new Map([
      [root, "import { service } from '../desktop-service'"],
      [dependency, "import './acp/session'; const electron = require('electron')"]
    ])
    expect(
      electronImportChains(
        [root],
        (file) => sources.get(file) ?? '',
        (file, specifier) => {
          const target = `${resolve(dirname(file), specifier)}.ts`
          return sources.has(target) ? target : null
        }
      )
    ).toEqual(['src/main/acp/session.ts -> src/main/desktop-service.ts -> electron'])
  })

  it('rejects direct Electron type imports without following erased dependencies', () => {
    const root = join(MAIN_ROOT, 'acp/session.ts')
    expect(
      electronImportChains(
        [root],
        () => "import type { BrowserWindow } from 'electron'",
        () => null
      )
    ).toEqual(['src/main/acp/session.ts -> electron'])
    expect(
      electronImportChains(
        [root],
        (file) =>
          file === root
            ? "import type { DesktopType } from '../desktop-service'"
            : "import 'electron'",
        () => join(MAIN_ROOT, 'desktop-service.ts')
      )
    ).toEqual([])
  })

  it('keeps structured chat runnable in orcad without Electron, including local dependencies', () => {
    expect(
      electronImportChains(
        structuredChatFiles(),
        (file) => readFileSync(file, 'utf8'),
        resolveSourceImport
      ),
      'Structured chat runs in orcad and orca serve without Electron. Move desktop dependencies out of this lane; import chains below reach Electron.'
    ).toEqual([])
  })
})
