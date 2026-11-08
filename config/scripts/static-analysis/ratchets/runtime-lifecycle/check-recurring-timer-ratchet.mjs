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

function isHostIntervalCallee(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'setInterval' &&
    ts.isIdentifier(node.expression) &&
    TIMER_HOSTS.has(node.expression.text)
  )
}

function isTimerModuleLoad(node) {
  if (ts.isStringLiteral(node)) {
    return TIMER_MODULES.includes(node.text)
  }
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length > 0 &&
    ts.isStringLiteral(node.arguments[0]) &&
    TIMER_MODULES.includes(node.arguments[0].text)
  )
}

// A local `setInterval` binding from node:timers (import or require destructuring).
function bindsModuleSetInterval(node) {
  if (ts.isImportSpecifier(node)) {
    return (
      node.name.text === 'setInterval' &&
      isTimerModuleLoad(node.parent.parent.parent.moduleSpecifier)
    )
  }
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === 'setInterval') {
    const declaration = node.parent.parent
    return (
      ts.isVariableDeclaration(declaration) &&
      !!declaration.initializer &&
      isTimerModuleLoad(declaration.initializer)
    )
  }
  return false
}

export function countRecurringTimers(rel, source) {
  if (!source.includes('setInterval')) {
    return 0
  }
  const file = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true)
  // Bare calls of a module-bound setInterval are already counted by the import collector.
  let bindsModule = false
  let bare = 0
  let hosted = 0
  const visit = (node) => {
    bindsModule ||= bindsModuleSetInterval(node)
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'setInterval') {
        bare += 1
      } else if (isHostIntervalCallee(node.expression)) {
        hosted += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return (bindsModule ? 0 : bare) + hosted + timerImports.collectUses(rel, source).count
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
        '# src/renderer, src/shared and src/cli, per file. A self-rescheduling setTimeout is not counted; it must back off or pause while hidden.',
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
