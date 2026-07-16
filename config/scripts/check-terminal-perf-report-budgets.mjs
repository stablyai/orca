import { basename } from 'node:path'
import { collectTerminalPerfRows, readJsonReport } from './terminal-perf-report-annotations.mjs'

const reportPaths = process.argv.slice(2)
if (reportPaths[0] === '--') {
  reportPaths.shift()
}

if (reportPaths.length === 0) {
  console.error(
    'Usage: node config/scripts/check-terminal-perf-report-budgets.mjs <playwright-json>...'
  )
  process.exit(1)
}

// Why: these mirror the e2e regression ceilings so saved JSON reports can fail
// in automation without rerunning Electron or changing the human summary table.
const BUDGETS = {
  maxMedianKeyLatencyMs: 75,
  maxWorstKeyLatencyMs: 300,
  maxRevisitLatencyMs: 300,
  maxTimerDriftMs: 150,
  // Why: mirrors MAX_TIMER_DRIFT_UNDER_LOAD_MS in artificial-opencode-terminal-load.spec.ts
  // so injected multi-pane redraw rows are not judged against the unloaded ceiling.
  maxTimerDriftUnderLoadMs: 2_500,
  maxScrollLatencyMs: 150,
  maxRestoreLatencyMs: 1000,
  maxRendererQueuedChars: 2 * 1024 * 1024,
  maxRendererPeakQueuedChars: 2 * 1024 * 1024,
  maxRendererDroppedBacklogs: 0
}

// Why: only these annotation types assert against MAX_TIMER_DRIFT_UNDER_LOAD_MS
// in the e2e suite; other rows keep the unloaded smoke ceiling.
function isUnderLoadTimerDriftScenario(scenario) {
  return (
    scenario === 'opencode-same-workspace-typing' ||
    scenario === 'opencode-cross-workspace-typing' ||
    scenario.startsWith('opencode-scale-same-workspace-') ||
    scenario.startsWith('opencode-scale-cross-workspace-')
  )
}

function parseMs(value, fieldName, row, failures) {
  if (value == null || value === '') {
    return null
  }
  const match = String(value).match(/^(-?\d+(?:\.\d+)?)ms$/)
  if (!match) {
    failures.push(`${row.source} ${row.scenario}: ${fieldName} value "${value}" is malformed`)
    return null
  }
  return Number(match[1])
}

function parseCount(value, fieldName, row, failures) {
  if (value == null || value === '') {
    return null
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    failures.push(`${row.source} ${row.scenario}: ${fieldName} value "${value}" is malformed`)
    return null
  }
  return parsed
}

function addMaxFailure(failures, row, label, actual, budget, unit = '') {
  if (actual == null || actual <= budget) {
    return
  }
  failures.push(
    `${row.source} ${row.scenario}: ${label} ${actual}${unit} exceeded budget ${budget}${unit}`
  )
}

function validateRow(row) {
  const failures = []
  let checkedMetricCount = 0
  const addBudgetCheck = (label, actual, budget, unit = '') => {
    if (actual != null) {
      checkedMetricCount += 1
    }
    addMaxFailure(failures, row, label, actual, budget, unit)
  }
  addBudgetCheck(
    'median typing latency',
    parseMs(row.median, 'median', row, failures),
    BUDGETS.maxMedianKeyLatencyMs,
    'ms'
  )
  addBudgetCheck(
    'worst typing latency',
    parseMs(row.worst, 'worst', row, failures),
    BUDGETS.maxWorstKeyLatencyMs,
    'ms'
  )
  addBudgetCheck(
    'revisit latency',
    parseMs(row.revisit, 'revisit', row, failures),
    BUDGETS.maxRevisitLatencyMs,
    'ms'
  )
  addBudgetCheck(
    'timer drift',
    parseMs(row.maxTimerDrift, 'maxTimerDrift', row, failures),
    isUnderLoadTimerDriftScenario(row.scenario)
      ? BUDGETS.maxTimerDriftUnderLoadMs
      : BUDGETS.maxTimerDriftMs,
    'ms'
  )
  addBudgetCheck(
    'scroll latency',
    parseMs(row.scroll, 'scroll', row, failures),
    BUDGETS.maxScrollLatencyMs,
    'ms'
  )
  addBudgetCheck(
    'restore latency',
    parseMs(row.restore, 'restore', row, failures),
    BUDGETS.maxRestoreLatencyMs,
    'ms'
  )
  addBudgetCheck(
    'renderer queued chars',
    parseCount(row.rendererQueuedChars, 'rendererQueuedChars', row, failures),
    BUDGETS.maxRendererQueuedChars
  )
  addBudgetCheck(
    'renderer peak queued chars',
    parseCount(row.rendererPeakQueuedChars, 'rendererPeakQueuedChars', row, failures),
    BUDGETS.maxRendererPeakQueuedChars
  )
  addBudgetCheck(
    'renderer dropped backlogs',
    parseCount(row.rendererDroppedBacklogs, 'rendererDroppedBacklogs', row, failures),
    BUDGETS.maxRendererDroppedBacklogs
  )
  // Why: parked-memory rows carry heap/view-count metrics with no latency
  // budget; recognize them so memory-only scenarios pass the gate instead of
  // tripping the "no recognized budget metrics" guard.
  for (const fieldName of ['heapUsedMB', 'liveTerminals', 'livePaneManagers']) {
    if (parseCount(row[fieldName], fieldName, row, failures) != null) {
      checkedMetricCount += 1
    }
  }
  if (checkedMetricCount === 0) {
    failures.push(`${row.source} ${row.scenario}: no recognized budget metrics found`)
  }
  return failures
}

const rows = reportPaths.flatMap((path) =>
  collectTerminalPerfRows(readJsonReport(path), basename(path))
)

if (rows.length === 0) {
  console.error('No OpenCode terminal perf annotations found.')
  process.exit(1)
}

const failures = rows.flatMap(validateRow)
if (failures.length > 0) {
  console.error(`Terminal perf budget check failed with ${failures.length} violation(s):`)
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log(`Terminal perf budget check passed for ${rows.length} annotation row(s).`)
