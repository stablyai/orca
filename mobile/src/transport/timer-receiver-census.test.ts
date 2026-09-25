import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'
import { censusSourceFiles } from '../test-support/census-source-files'

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TIMER_GLOBALS = new Set(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'])
const GLOBAL_RECEIVERS = new Set(['global', 'globalThis', 'window'])
const SHARED_DEFAULTS = new Set(['defaultScheduleTimer', 'defaultCancelTimer'])

// Sites that take their default from timer-scheduler; the census is meaningless if it
// cannot see them, so an empty or misdirected walk fails instead of passing vacuously.
const SHARED_DEFAULT_SITES = [
  'files/mobile-file-preview-navigation.ts',
  'transport/host-open-retry-scheduler.ts',
  'transport/mobile-endpoint-lifecycle.ts',
  'transport/mobile-endpoint-supervisor-test-fakes.ts',
  'transport/rpc-session-liveness-watchdog.ts'
]

const PARKING_OPERATORS = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.BarBarEqualsToken
])

type Census = { parked: string[]; shared: string[] }

function productFiles(): string[] {
  return censusSourceFiles(SOURCE_ROOT)
    .map((path) => relative(SOURCE_ROOT, path).replaceAll('\\', '/'))
    .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
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
// through: a nullish/logical default, an object literal member, or an assignment onto a
// property. A plain local capture stays legal: calling it bare leaves the receiver undefined.
function parkedTimer(node: ts.Node): ts.Node | null {
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind
    const parks =
      PARKING_OPERATORS.has(operator) ||
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

function scanSource(relativePath: string, text: string, census: Census): void {
  const sourceFile = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    const candidate = parkedTimer(node)
    const name = candidate === null ? null : timerName(candidate)
    if (candidate !== null && name !== null) {
      const line = sourceFile.getLineAndCharacterOfPosition(candidate.getStart(sourceFile)).line + 1
      census.parked.push(`${relativePath}:${line} ${name}`)
    }
    if (ts.isIdentifier(node) && SHARED_DEFAULTS.has(node.text)) {
      census.shared.push(relativePath)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function parkedIn(source: string): string[] {
  const census: Census = { parked: [], shared: [] }
  scanSource('fixture.ts', source, census)
  return census.parked
}

describe('global timer receiver census', () => {
  const census: Census = { parked: [], shared: [] }
  for (const relativePath of productFiles()) {
    scanSource(relativePath, readFileSync(`${SOURCE_ROOT}${relativePath}`, 'utf8'), census)
  }

  it('sees the shared receiver-free defaults, so an empty or misdirected walk cannot pass', () => {
    expect(census.shared).toEqual(expect.arrayContaining(SHARED_DEFAULT_SITES))
  })

  it('parks no bare global timer where a later call would supply a non-global receiver', () => {
    expect(census.parked).toEqual([])
  })

  it.each([
    ['a nullish default', 'const schedule = injected ?? setTimeout'],
    ['a logical default', 'const schedule = injected || setTimeout'],
    ['a nullish assignment default', 'schedule ??= setTimeout'],
    ['a logical assignment default', 'schedule ||= setTimeout'],
    ['an object literal member', 'const deps = { setTimer: setTimeout }'],
    ['a shorthand object member', 'const deps = { setTimeout }'],
    ['an assignment onto a property', 'this.setTimer = setTimeout'],
    ['a qualified global read', 'const deps = { setTimer: globalThis.setTimeout }']
  ])('flags a global timer parked by %s', (_form, source) => {
    expect(parkedIn(source)).toEqual(['fixture.ts:1 setTimeout'])
  })

  it('leaves a plain local capture alone, which a bare call invokes receiver-free', () => {
    expect(parkedIn('const schedule = globalThis.setTimeout')).toEqual([])
  })
})
