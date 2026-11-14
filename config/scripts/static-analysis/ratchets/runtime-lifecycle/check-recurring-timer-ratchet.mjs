import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import { createGatedCallCollector } from '../../process-boundaries/gated-call-use-collector.mjs'
import { readTrackedSources, runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'
import { isTestOnlySourcePath } from '../../process-boundaries/test-only-source-path.mjs'

// Fixed-cadence polls that never back off, settle or pause while hidden were the most common perf fix class (#39734, #38902, #33829, #39650).

const BASELINE_PATH = 'config/recurring-timer-baseline.txt'
const SCAN_ROOTS = ['src/main', 'src/renderer/src', 'src/shared', 'src/cli']
const TIMER_HOSTS = new Set(['window', 'globalThis', 'self', 'global'])
const TIMER_MODULES = ['timers', 'node:timers', 'timers/promises', 'node:timers/promises']
const timerImports = createGatedCallCollector(
  [
    {
      modules: TIMER_MODULES,
      advice: { setInterval: 'prefer a push signal or a backing-off timer' }
    }
  ],
  'recurring-timer'
)

function isScannedPath(rel) {
  return /\.[cm]?[jt]sx?$/.test(rel) && !rel.endsWith('.d.ts') && !isTestOnlySourcePath(rel)
}

function isHostInterval(node) {
  if (!ts.isIdentifier(node.expression) || !TIMER_HOSTS.has(node.expression.text)) {
    return false
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === 'setInterval'
  }
  return (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === 'setInterval'
  )
}

// Skips transparent wrappers so `typeof (setInterval)` and `(setInterval) = x` read like the bare forms.
function outerExpression(node) {
  let current = node
  while (ts.isParenthesizedExpression(current.parent)) {
    current = current.parent
  }
  return current
}

// Reads the timer value: not a plain `=` target (compound assignments read it), a `typeof` probe or a JSX tag name.
function isRuntimeRead(node) {
  const outer = outerExpression(node)
  const parent = outer.parent
  return !(
    ts.isTypeOfExpression(parent) ||
    (ts.isBinaryExpression(parent) &&
      parent.left === outer &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
    ((ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxClosingElement(parent)) &&
      parent.tagName === node)
  )
}

// A value reference to the identifier, not a declaration, member name or key.
function isBareValueReference(node) {
  const parent = node.parent
  return (
    isRuntimeRead(node) &&
    !(
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent) ||
      (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
    )
  )
}

const SCOPE_OPTIONS = { noLib: true, noResolve: true, allowJs: true, types: [] }

// Counts references, not calls, to the global timer, so `const every = setInterval; every(f)` and
// `window['setInterval']` are charged once. A bare name is the global when it binds to nothing
// declared in this file (resolved per scope); module bindings and their aliases are the collector's.
function countGlobalTimerReferences(source) {
  const host = ts.createCompilerHost(SCOPE_OPTIONS)
  host.getSourceFile = (name) => (name === source.fileName ? source : undefined)
  const checker = ts.createProgram([source.fileName], SCOPE_OPTIONS, host).getTypeChecker()
  let count = 0
  const visit = (node) => {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) {
      return
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isHostInterval(node) &&
      isRuntimeRead(node)
    ) {
      count += 1
    } else if (ts.isIdentifier(node) && node.text === 'setInterval' && isBareValueReference(node)) {
      // A shorthand `{ setInterval }` names the property; its value is the binding being read.
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node)
      const declarations = symbol?.declarations ?? []
      if (!declarations.some((declaration) => declaration.getSourceFile() === source)) {
        count += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

export function countRecurringTimers(rel, source) {
  if (!source.includes('setInterval')) {
    return 0
  }
  const file = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true)
  return countGlobalTimerReferences(file) + timerImports.collectUses(rel, source).count
}

export function collectRecurringTimerCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    const count = countRecurringTimers(rel, source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'recurring-timer',
      baselinePath: BASELINE_PATH,
      header: [
        '# setInterval calls (global, or imported from node:timers / node:timers/promises) in production src/main,',
        '# src/renderer, src/shared and src/cli, per file. Bare calls are resolved per scope; imported bindings follow the shared',
        '# collector (file-wide). Not counted: destructuring off a global object, a self-rescheduling setTimeout (it must back off or pause while hidden).',
        '# This is a RATCHET: counts may only go DOWN.',
        '# Prune after removing intervals: pnpm check:recurring-timer-ratchet --prune'
      ],
      collect: collectRecurringTimerCounts,
      unit: 'setInterval call(s)',
      fix: [
        'A fixed-cadence interval keeps working when nothing changes, the window is hidden or its dependency keeps failing.',
        'Prefer a push signal; otherwise use installWindowVisibilityInterval (renderer) or a timer that backs off and stops when idle.',
        'Rewriting it as a self-rescheduling setTimeout at the same fixed cadence is the same bug; review will treat it so.',
        `An interval whose cadence is the feature (a clock, a heartbeat with a stop) may raise the file's count in ${BASELINE_PATH} with reviewer sign-off.`
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
