import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TIMER_GLOBALS = new Set(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'])
const GLOBAL_RECEIVERS = new Set(['global', 'globalThis', 'window'])

// Sites whose default calls the global receiver-free; the census is meaningless if it
// cannot see them, so an empty or misdirected walk fails instead of passing vacuously.
const WRAPPED_DEFAULT_SITES = [
  'files/mobile-file-preview-navigation.ts',
  'transport/host-open-retry-scheduler.ts',
  'transport/mobile-endpoint-lifecycle.ts',
  'transport/mobile-endpoint-supervisor-test-fakes.ts',
  'transport/rpc-session-liveness-watchdog.ts'
]

function productFiles(): string[] {
  return readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$|\.generated\.ts$/.test(entry))
    .map((entry) => entry.replaceAll('\\', '/'))
}

function timerName(node: ts.Node): string | null {
  if (ts.isIdentifier(node) && TIMER_GLOBALS.has(node.text)) {
    return node.text
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    TIMER_GLOBALS.has(node.name.text) &&
    ts.isIdentifier(node.expression) &&
    GLOBAL_RECEIVERS.has(node.expression.text)
  ) {
    return node.name.text
  }
  return null
}

// The receiver is only lost once the function is parked somewhere a later call reaches
// through: a `??` default, an object literal member, or an assignment onto a property.
// A plain local capture is safe, because calling it bare leaves the receiver undefined.
function parkedTimer(node: ts.Node): ts.Node | null {
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind
    const parks =
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      (operator === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left))
    return parks ? node.right : null
  }
  if (ts.isPropertyAssignment(node)) {
    return node.initializer
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    return node.name
  }
  return null
}

function scan(): { parked: string[]; wrapped: string[] } {
  const parked: string[] = []
  const wrapped: string[] = []
  for (const relativePath of productFiles()) {
    const text = readFileSync(`${SOURCE_ROOT}${relativePath}`, 'utf8')
    const sourceFile = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true)
    const lineOf = (node: ts.Node): number =>
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    const visit = (node: ts.Node): void => {
      const candidate = parkedTimer(node)
      const name = candidate === null ? null : timerName(candidate)
      if (candidate !== null && name !== null) {
        parked.push(`${relativePath}:${lineOf(candidate)} ${name}`)
      }
      if (
        ts.isCallExpression(node) &&
        timerName(node.expression) !== null &&
        ts.isArrowFunction(node.parent)
      ) {
        wrapped.push(relativePath)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return { parked, wrapped }
}

describe('global timer receiver census', () => {
  const census = scan()

  it('sees the receiver-free wrappers, so an empty or misdirected walk cannot pass', () => {
    expect(census.wrapped).toEqual(expect.arrayContaining(WRAPPED_DEFAULT_SITES))
  })

  it('parks no bare global timer where a later call would supply a non-global receiver', () => {
    expect(census.parked).toEqual([])
  })
})
