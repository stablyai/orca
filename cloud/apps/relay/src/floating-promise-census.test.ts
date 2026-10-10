import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// A promise nobody awaits rejects into Node's unhandledRejection, which ends the process:
// one lost database reply would drop every host on the cell. Production code must await,
// return, store and use, or `.catch` every promise it starts.
// Exempt: functions written to settle every failure themselves. Keyed file#name.
const NEVER_REJECTS = new Map([
  ['relay-background-operation.ts#runRelayBackgroundOperation', 'catches and logs every failure'],
  ['assignment-cleanup-steps.ts#runAssignmentCleanup', 'runs each step through the above'],
  ['cell-heartbeat-client.ts#send', 'one try/catch around the whole send'],
  ['control-renewal-batch.ts#flush', 'rejects the waiters, never itself'],
  ['regional-rehome-worker.ts#run', 'one try/catch around the whole poll']
])

const sourceDirectory = fileURLToPath(new URL('.', import.meta.url))
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true
}

function productionFiles(): string[] {
  return readdirSync(sourceDirectory)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .map((entry) => join(sourceDirectory, entry))
}

function isPromise(checker: ts.TypeChecker, node: ts.Node): boolean {
  return checker.getTypeAtLocation(node).getSymbol()?.getName() === 'Promise'
}

function isChainStep(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) && ['then', 'catch', 'finally'].includes(node.name.text)
  )
}

// Walks a `.then/.catch/.finally` chain up to the expression that consumes it.
function consumer(call: ts.CallExpression): { node: ts.Node; caught: boolean } {
  let node: ts.Node = call
  let caught = false
  while (isChainStep(node.parent) && ts.isCallExpression(node.parent.parent)) {
    const step = node.parent.parent
    const method = node.parent.name.text
    if (method === 'catch' || (method === 'then' && step.arguments.length > 1)) caught = true
    node = step
  }
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent
  return { node, caught }
}

// A callback whose contextual type returns void (setTimeout, an event listener) drops the promise.
function discardedByCallback(checker: ts.TypeChecker, fn: ts.ArrowFunction): boolean {
  const signatures = checker.getContextualType(fn)?.getCallSignatures() ?? []
  return (
    signatures.length > 0 &&
    signatures.every(
      (signature) => (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Void) !== 0
    )
  )
}

function neverRead(checker: ts.TypeChecker, declaration: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(declaration.name)) return false
  const symbol = checker.getSymbolAtLocation(declaration.name)
  let read = false
  const visit = (node: ts.Node): void => {
    if (read) return
    if (ts.isIdentifier(node) && node !== declaration.name) {
      read = checker.getSymbolAtLocation(node) === symbol
    }
    ts.forEachChild(node, visit)
  }
  visit(declaration.getSourceFile())
  return !read
}

function floatingShape(checker: ts.TypeChecker, call: ts.CallExpression): string | null {
  const { node, caught } = consumer(call)
  if (caught) return null
  const parent = node.parent
  if (ts.isExpressionStatement(parent)) return 'statement'
  if (ts.isVoidExpression(parent)) return 'void'
  if (ts.isArrowFunction(parent) && parent.body === node && discardedByCallback(checker, parent)) {
    return 'callback'
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    return neverRead(checker, parent) ? 'unread' : null
  }
  return null
}

function exempt(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  const declaration = checker.getResolvedSignature(call)?.getDeclaration()
  if (!declaration) return false
  const name = ts.getNameOfDeclaration(declaration)?.getText()
  return NEVER_REJECTS.has(`${basename(declaration.getSourceFile().fileName)}#${name}`)
}

function census(program: ts.Program, files: string[]): { floating: string[]; seen: number } {
  const checker = program.getTypeChecker()
  const floating: string[] = []
  let seen = 0
  for (const file of files) {
    const source = program.getSourceFile(file)
    if (!source) throw new Error(`not in program: ${file}`)
    const visit = (node: ts.Node): void => {
      // A chain step is judged through the call at its base.
      if (ts.isCallExpression(node) && !isChainStep(node.expression) && isPromise(checker, node)) {
        seen += 1
        const shape = floatingShape(checker, node)
        if (shape && !exempt(checker, node)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          floating.push(`${shape} ${basename(file)}:${line + 1} ${node.expression.getText(source)}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { floating, seen }
}

function probeCensus(text: string): string[] {
  const name = join(sourceDirectory, 'floating-promise-probe.ts')
  const host = ts.createCompilerHost(COMPILER_OPTIONS)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, language) =>
    fileName === name
      ? ts.createSourceFile(fileName, text, language)
      : getSourceFile(fileName, language)
  const fileExists = host.fileExists.bind(host)
  host.fileExists = (fileName) => fileName === name || fileExists(fileName)
  return census(ts.createProgram([name], COMPILER_OPTIONS, host), [name]).floating.map(
    (entry) => entry.split(' ')[0]!
  )
}

describe('floating promises', () => {
  it('finds none in production code', () => {
    const files = productionFiles()
    const result = census(ts.createProgram(files, COMPILER_OPTIONS), files)
    // Resolution worked: a broken program would see no promises and pass vacuously.
    expect(result.seen).toBeGreaterThan(500)
    expect(result.floating).toEqual([])
  }, 120_000)

  it('flags each floating shape and accepts the handled ones', () => {
    const prelude = `declare const db: { query(sql: string): Promise<unknown[]> }
      async function wrapper(): Promise<void> { await db.query('x') }\n`
    const floating = [
      `db.query('x')`,
      `void db.query('x')`,
      `void wrapper()`,
      `db.query('x').then(() => 1)`,
      `setTimeout(() => db.query('x'), 1)`,
      `export function f() { const pending = db.query('x') }`
    ]
    for (const statement of floating) {
      expect({ statement, shapes: probeCensus(prelude + statement) }).toEqual({
        statement,
        shapes: [expect.any(String)]
      })
    }
    const handled = [
      `export async function f() { await db.query('x') }`,
      `void db.query('x').catch(() => undefined)`,
      `void db.query('x').then(() => 1, () => 2)`,
      `export async function f() { const pending = db.query('x'); await pending }`,
      `export const g = () => db.query('x')`
    ]
    for (const statement of handled) {
      expect({ statement, shapes: probeCensus(prelude + statement) }).toEqual({
        statement,
        shapes: []
      })
    }
  })
})
