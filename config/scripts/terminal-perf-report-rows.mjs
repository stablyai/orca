import { readFileSync } from 'node:fs'

const BUDGETS = {
  medianMs: 75,
  worstMs: 300,
  revisitMs: 300,
  maxTimerDriftMs: 150,
  scrollMs: 150,
  restoreMs: 1000,
  rendererQueuedChars: 2 * 1024 * 1024,
  rendererPeakQueuedChars: 2 * 1024 * 1024,
  rendererDroppedBacklogs: 0
}

const SCENARIO_LABELS = [
  ['opencode-scale-same-workspace', 'Same workspace panes'],
  ['opencode-scale-cross-workspace', 'Cross-workspace hidden panes'],
  ['opencode-scale-pressure', 'ACK-backpressured PTYs'],
  ['opencode-scale-hidden-pressure', 'Hidden real PTYs'],
  ['opencode-cross-workspace-typing', 'Cross-workspace typing'],
  ['opencode-main-pressure', 'Main renderer pressure'],
  ['opencode-hidden-pressure', 'Hidden pressure'],
  ['opencode-revisit-pressure', 'Revisit under pressure'],
  // Why: the prefix also matches opencode-parked-memory-disabled, so both
  // parked-memory scenarios group under one label.
  ['opencode-parked-memory', 'Parked hidden terminal memory']
]

export function readJsonReport(path) {
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

export function collectTerminalPerfRows(report, source) {
  const rows = []
  const visitSuite = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const annotation of test.annotations ?? []) {
          if (!annotation.type.startsWith('opencode-')) {
            continue
          }
          rows.push(
            normalizeRow({
              source,
              scenario: annotation.type,
              ...parseAnnotationDescription(annotation.description ?? '')
            })
          )
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

function parseMs(value) {
  const match = String(value ?? '').match(/^(-?\d+(?:\.\d+)?)ms$/)
  return match ? Number(match[1]) : null
}

function parseCount(value) {
  if (value == null || value === '') {
    return null
  }
  const count = Number(value)
  return Number.isFinite(count) ? count : null
}

function normalizeRow(row) {
  return {
    ...row,
    group: scenarioGroup(row.scenario),
    panes: parseCount(row.panes),
    frames: parseCount(row.frames),
    medianMs: parseMs(row.median),
    worstMs: parseMs(row.worst),
    revisitMs: parseMs(row.revisit),
    maxTimerDriftMs: parseMs(row.maxTimerDrift),
    scrollMs: parseMs(row.scroll),
    restoreMs: parseMs(row.restore),
    rendererQueuedChars: parseCount(row.rendererQueuedChars),
    rendererPeakQueuedChars: parseCount(row.rendererPeakQueuedChars),
    rendererDroppedBacklogs: parseCount(row.rendererDroppedBacklogs),
    mainPeakPendingChars: parseCount(row.mainPeakPendingChars),
    mainPeakInFlightChars: parseCount(row.mainPeakInFlightChars),
    heldAckChars: parseCount(row.heldAckChars),
    hiddenSkippedChars: parseCount(row.hiddenSkippedChars),
    // Why: parked-memory annotations report a fractional MB heap figure plus
    // live renderer view counts; Number() keeps the MB float intact.
    heapUsedMB: parseCount(row.heapUsedMB),
    liveTerminals: parseCount(row.liveTerminals),
    livePaneManagers: parseCount(row.livePaneManagers)
  }
}

export function scenarioGroup(scenario) {
  for (const [prefix, label] of SCENARIO_LABELS) {
    if (scenario.startsWith(prefix)) {
      return label
    }
  }
  return 'Other terminal scenarios'
}

function scenarioSortKey(scenario) {
  const prefixIndex = SCENARIO_LABELS.findIndex(([prefix]) => scenario.startsWith(prefix))
  const paneMatch = scenario.match(/-(\d+)$/)
  return [
    prefixIndex === -1 ? SCENARIO_LABELS.length : prefixIndex,
    paneMatch ? Number(paneMatch[1]) : 0,
    scenario
  ]
}

export function compareScenarios(a, b) {
  const ka = scenarioSortKey(a)
  const kb = scenarioSortKey(b)
  if (ka[0] !== kb[0]) {
    return ka[0] - kb[0]
  }
  if (ka[1] !== kb[1]) {
    return ka[1] - kb[1]
  }
  return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0
}

export function scenarioTitle(scenario, row) {
  const group = scenarioGroup(scenario)
  if (row?.panes != null) {
    return `${group} — ${row.panes} panes`
  }
  return group
}

export function budgetFailures(row) {
  const failures = []
  for (const [key, budget] of Object.entries(BUDGETS)) {
    const value = row[key]
    if (value == null) {
      continue
    }
    if (value > budget) {
      failures.push(`${key} ${value} > ${budget}`)
    }
  }
  return failures
}

export function formatMs(value) {
  if (value == null) {
    return '—'
  }
  return `${value.toFixed(1)}ms`
}

export function formatLargeValue(value) {
  if (value == null) {
    return '—'
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(2)}M`
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)}k`
  }
  return String(value)
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
