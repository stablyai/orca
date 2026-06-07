import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const reportPaths = process.argv.slice(2)
if (reportPaths[0] === '--') {
  reportPaths.shift()
}

if (reportPaths.length === 0) {
  console.error(
    'Usage: node config/scripts/summarize-terminal-perf-report.mjs <playwright-json>...'
  )
  process.exit(1)
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

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|')
}

function printMarkdownTable(rows) {
  const columns = [
    ['Source', 'source'],
    ['Scenario', 'scenario'],
    ['Panes', 'panes'],
    ['Frames', 'frames'],
    ['Median', 'median'],
    ['Worst', 'worst'],
    ['Max Drift', 'maxTimerDrift'],
    ['Hidden Skips', 'hiddenSkips'],
    ['Hidden Chars', 'hiddenSkippedChars'],
    ['Foreground Enqueues', 'deferredForegroundEnqueue'],
    ['Foreground Writes', 'deferredForegroundWrite'],
    ['Drains', 'scheduledDrains'],
    ['Main Pending PTYs', 'mainPendingPtys'],
    ['Main Pending Chars', 'mainPendingChars'],
    ['Main Max Pending', 'mainMaxPendingChars'],
    ['Main In-Flight PTYs', 'mainInFlightPtys'],
    ['Main In-Flight Chars', 'mainInFlightChars'],
    ['Main Max In-Flight', 'mainMaxInFlightChars'],
    ['Main Active PTYs', 'mainActivePtys'],
    ['Main Flush Scheduled', 'mainFlushScheduled'],
    ['Main Peak Pending', 'mainPeakPendingChars'],
    ['Main Peak Max Pending', 'mainPeakMaxPendingChars'],
    ['Main Peak In-Flight', 'mainPeakInFlightChars'],
    ['Main Peak Max In-Flight', 'mainPeakMaxInFlightChars'],
    ['Main ACK-Gated Skips', 'mainAckGatedFlushSkips'],
    ['Held ACK PTYs', 'heldAckPtys'],
    ['Held ACK Chars', 'heldAckChars'],
    ['Gated ACK PTYs', 'gatedAckPtys']
  ]

  console.log(`| ${columns.map(([label]) => label).join(' | ')} |`)
  console.log(`| ${columns.map(() => '---').join(' | ')} |`)
  for (const row of rows) {
    console.log(`| ${columns.map(([, key]) => markdownCell(row[key])).join(' | ')} |`)
  }
}

const rows = reportPaths.flatMap((path) =>
  collectTerminalPerfRows(readJsonReport(path), basename(path))
)

if (rows.length === 0) {
  console.error('No OpenCode terminal perf annotations found.')
  process.exit(1)
}

printMarkdownTable(rows)
