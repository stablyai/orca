// L80 census: production code touches a PTY record's pane copies only through paneOfPty's
// window-owned branch and the switch-guarded writers. Type-aware, so a Pick, a union or a
// destructure of the record is caught too; an Object.assign or spread onto a record is not
// checked; the switch-on trap test is the backstop. Rerun: pnpm test <this file>.
import path from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../../..')
const RECORD_FILE = path.join(ROOT, 'src/main/runtime/runtime-terminal-state-records.ts')
const COPY_FIELDS = new Set(['tabId', 'paneKey', 'surfaceRecordedAtGraphSequence'])

/** File → the functions in it allowed to touch the copies; each must branch on the switch. */
const ALLOWED: Record<string, readonly string[]> = {
  'src/main/runtime/terminal/surface/pty-pane-query.ts': ['paneOfPty'],
  'src/main/runtime/pty-recorded-surface-topology.ts': [
    'recordPtySurfaceClaim',
    'recordPtySurface',
    'forgetPtySurface'
  ],
  'src/main/runtime/terminal/identity/pty-worktree-record.ts': ['recordPtyWorktree']
}

function isProductionFile(fileName: string): boolean {
  return (
    fileName.startsWith(path.join(ROOT, 'src/')) &&
    !/\.(test|spec)\.tsx?$/.test(fileName) &&
    !/[-.](test-)?(fixture|harness)\b|test-support/.test(fileName) &&
    !fileName.includes(`${path.sep}orca-runtime-tests${path.sep}`)
  )
}

/** Whether code (not a comment) in the function reads the build switch. */
function readsSwitch(node: ts.Node): boolean {
  return (
    (ts.isIdentifier(node) && node.text === 'ORCA_LAYOUT_OWNER_IS_MAIN') ||
    ts.forEachChild(node, readsSwitch) === true
  )
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text
    }
  }
  return null
}

type Census = { sites: { site: string; allowed: boolean }[]; unguarded: string[] }

function collectCopyAccesses(): Census {
  const configPath = path.join(ROOT, 'config/tsconfig.node.json')
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    { noEmit: true, composite: false, incremental: false },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
  )
  if (!parsed) {
    throw new Error('cannot read config/tsconfig.node.json')
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  const checker = program.getTypeChecker()
  const recordSource = program.getSourceFile(RECORD_FILE)
  if (!recordSource) {
    throw new Error('the PTY record type file is not in the program')
  }
  const copyDeclarations = new Set<ts.Declaration>()
  recordSource.forEachChild(function visit(node) {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === 'RuntimePtyWorktreeRecord' &&
      ts.isIntersectionTypeNode(node.type)
    ) {
      for (const member of node.type.types) {
        if (ts.isTypeLiteralNode(member)) {
          for (const property of member.members) {
            if (
              ts.isPropertySignature(property) &&
              ts.isIdentifier(property.name) &&
              COPY_FIELDS.has(property.name.text)
            ) {
              copyDeclarations.add(property)
            }
          }
        }
      }
    }
  })
  if (copyDeclarations.size !== COPY_FIELDS.size) {
    throw new Error(`found ${copyDeclarations.size} of the record's pane copy declarations`)
  }
  const namesCopy = (symbol: ts.Symbol | undefined): boolean =>
    (symbol?.declarations ?? []).some((declaration) => copyDeclarations.has(declaration)) ||
    // A union or mapped type's property is synthetic; its origins are the declared ones.
    (((symbol?.flags ?? 0) & ts.SymbolFlags.Transient) !== 0 &&
      checker
        .getRootSymbols(symbol!)
        .some((root) => (root.declarations ?? []).some((d) => copyDeclarations.has(d))))

  const sites: Census['sites'] = []
  const unguarded: string[] = []
  for (const [relative, functions] of Object.entries(ALLOWED)) {
    const source = program.getSourceFile(path.join(ROOT, relative))
    const found = new Set<string>()
    source?.forEachChild(function visit(node) {
      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        functions.includes(node.name.text) &&
        readsSwitch(node)
      ) {
        found.add(node.name.text)
      }
      ts.forEachChild(node, visit)
    })
    unguarded.push(...functions.filter((fn) => !found.has(fn)).map((fn) => `${relative} ${fn}`))
  }
  for (const source of program.getSourceFiles()) {
    if (!isProductionFile(source.fileName)) {
      continue
    }
    const relative = path.relative(ROOT, source.fileName).split(path.sep).join('/')
    const text = source.text
    if (![...COPY_FIELDS].some((field) => text.includes(field))) {
      continue
    }
    const record = (node: ts.Node, symbol: ts.Symbol | undefined): void => {
      if (!namesCopy(symbol)) {
        return
      }
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      const fn = enclosingFunctionName(node)
      sites.push({
        site: `${relative}:${line} ${fn ?? '<top>'}`,
        allowed: fn !== null && (ALLOWED[relative] ?? []).includes(fn)
      })
    }
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && COPY_FIELDS.has(node.name.text)) {
        record(node, checker.getSymbolAtLocation(node.name))
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        COPY_FIELDS.has(node.argumentExpression.text)
      ) {
        record(node, checker.getSymbolAtLocation(node.argumentExpression))
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name
        if (ts.isIdentifier(key) && COPY_FIELDS.has(key.text)) {
          const type = checker.getTypeAtLocation(node.parent)
          record(node, type.getProperty(key.text))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { sites, unguarded }
}

describe('PTY record pane copies (L80)', () => {
  it('are touched only by paneOfPty and the switch-guarded writers', () => {
    const { sites, unguarded } = collectCopyAccesses()
    expect(sites.filter((site) => !site.allowed).map((site) => site.site)).toEqual([])
    // Each allowed function branches on the switch, so the build with it on keeps no copy.
    expect(unguarded).toEqual([])
    // The census sees the allowed sites, so a resolver regression cannot pass it vacuously.
    expect(sites.some((site) => site.site.includes('pty-pane-query.ts'))).toBe(true)
  }, 180_000)
})
