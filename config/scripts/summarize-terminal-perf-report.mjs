import { basename } from 'node:path'
import { collectTerminalPerfRows, readJsonReport } from './terminal-perf-report-annotations.mjs'

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
    ['Scroll', 'scroll'],
    ['Restore', 'restore'],
    ['Max Drift', 'maxTimerDrift'],
    ['Hidden Skips', 'hiddenSkips'],
    ['Hidden Chars', 'hiddenSkippedChars'],
    ['Foreground Enqueues', 'deferredForegroundEnqueue'],
    ['Foreground Writes', 'deferredForegroundWrite'],
    ['Drains', 'scheduledDrains'],
    ['Renderer Queued Terms', 'rendererQueuedTerminals'],
    ['Renderer Queued Chars', 'rendererQueuedChars'],
    ['Renderer Peak Terms', 'rendererPeakQueuedTerminals'],
    ['Renderer Peak Chars', 'rendererPeakQueuedChars'],
    ['Renderer Peak By Term', 'rendererPeakQueuedCharsByTerminal'],
    ['Renderer Drops', 'rendererDroppedBacklogs'],
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
