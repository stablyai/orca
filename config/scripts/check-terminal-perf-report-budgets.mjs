import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

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

function readJsonReport(path) {
  const raw = readFileSync(path, 'utf8')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error(`${path}: no JSON object found`)
  }
  return JSON.parse(raw.slice(start, end + 1))
}

function parseAnnotationDescription(description) {
  const values = {}
  for (const part of description.split(/\s+/)) {
    const index = part.indexOf('=')
    if (index === -1) {
      continue
    }
    values[part.slice(0, index)] = part.slice(index + 1)
  }
  return values
}

function collectTerminalPerfRows(report, source) {
  const rows = []
  const visitSuite = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const annotation of test.annotations ?? []) {
          if (!annotation.type.startsWith('opencode-')) {
            continue
          }
          rows.push({
            source,
            scenario: annotation.type,
            ...parseAnnotationDescription(annotation.description ?? '')
          })
        }
      }
    }
    for (const child of suite.suites ?? []) {
      visitSuite(child)
    }
  }
  for (const suite of report.suites ?? []) {
    visitSuite(suite)
  }
  return rows
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
    'timer drift',
    parseMs(row.maxTimerDrift, 'maxTimerDrift', row, failures),
    BUDGETS.maxTimerDriftMs,
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
