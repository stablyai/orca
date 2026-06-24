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
  maxTimerDriftMs: 150,
  maxScrollLatencyMs: 150,
  maxRestoreLatencyMs: 1000,
  maxRendererQueuedChars: 2 * 1024 * 1024,
  maxRendererPeakQueuedChars: 2 * 1024 * 1024,
  maxRendererDroppedBacklogs: 0
}

const HIDDEN_REAL_PTY_BUDGETS = {
  ...BUDGETS,
  maxWorstKeyLatencyMs: 500,
  maxTimerDriftMs: 250,
  maxRestoreLatencyMs: 8000,
  maxRendererQueuedChars: 5 * 1024 * 1024,
  maxRendererPeakQueuedChars: 5 * 1024 * 1024
}

const SYNTHETIC_REDRAW_BUDGETS = {
  ...BUDGETS,
  maxMedianKeyLatencyMs: 150,
  maxWorstKeyLatencyMs: 1000
}

const ACK_PRESSURE_BUDGETS = {
  ...BUDGETS,
  maxMedianKeyLatencyMs: 750,
  maxWorstKeyLatencyMs: 5000,
  maxTimerDriftMs: 250,
  maxScrollLatencyMs: 300,
  maxRendererQueuedChars: 5 * 1024 * 1024,
  maxRendererPeakQueuedChars: 5 * 1024 * 1024
}

function budgetsForRow(row) {
  // Why: hidden real PTYs deliberately exercise source-pause recovery, which is
  // noisier than the default typing gate; keep the wider budget scenario-local.
  if (row.scenario.startsWith('opencode-hidden-real-pty-')) {
    return HIDDEN_REAL_PTY_BUDGETS
  }
  // Why: synthetic redraw storms keep median/timer/queue budgets tight, but one
  // Electron headless key sample can be noisier than the baseline keyboard path.
  if (
    row.scenario.startsWith('opencode-same-workspace-typing') ||
    row.scenario.startsWith('opencode-scale-same-workspace-') ||
    row.scenario.startsWith('opencode-cross-workspace-typing') ||
    row.scenario.startsWith('opencode-scale-cross-workspace-')
  ) {
    return SYNTHETIC_REDRAW_BUDGETS
  }
  // Why: ACK-gated rows validate bounded queues under real process pressure;
  // the first active echo can briefly wait on OS PTY scheduling.
  if (row.scenario.startsWith('opencode-main-pressure-active-')) {
    return ACK_PRESSURE_BUDGETS
  }
  return BUDGETS
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
  const budgets = budgetsForRow(row)
  const addBudgetCheck = (label, actual, budget, unit = '') => {
    if (actual != null) {
      checkedMetricCount += 1
    }
    addMaxFailure(failures, row, label, actual, budget, unit)
  }
  addBudgetCheck(
    'median typing latency',
    parseMs(row.median, 'median', row, failures),
    budgets.maxMedianKeyLatencyMs,
    'ms'
  )
  addBudgetCheck(
    'worst typing latency',
    parseMs(row.worst, 'worst', row, failures),
    budgets.maxWorstKeyLatencyMs,
    'ms'
  )
  addBudgetCheck(
    'timer drift',
    parseMs(row.maxTimerDrift, 'maxTimerDrift', row, failures),
    budgets.maxTimerDriftMs,
    'ms'
  )
  addBudgetCheck(
    'scroll latency',
    parseMs(row.scroll, 'scroll', row, failures),
    budgets.maxScrollLatencyMs,
    'ms'
  )
  addBudgetCheck(
    'restore latency',
    parseMs(row.restore, 'restore', row, failures),
    budgets.maxRestoreLatencyMs,
    'ms'
  )
  addBudgetCheck(
    'renderer queued chars',
    parseCount(row.rendererQueuedChars, 'rendererQueuedChars', row, failures),
    budgets.maxRendererQueuedChars
  )
  addBudgetCheck(
    'renderer peak queued chars',
    parseCount(row.rendererPeakQueuedChars, 'rendererPeakQueuedChars', row, failures),
    budgets.maxRendererPeakQueuedChars
  )
  addBudgetCheck(
    'renderer dropped backlogs',
    parseCount(row.rendererDroppedBacklogs, 'rendererDroppedBacklogs', row, failures),
    budgets.maxRendererDroppedBacklogs
  )
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
