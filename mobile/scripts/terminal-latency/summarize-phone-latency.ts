/**
 * Summarises recorded phone latency runs as Markdown tables.
 *
 *   tsx scripts/terminal-latency/summarize-phone-latency.ts phone-direct.jsonl [more.jsonl ...]
 *
 * Each cell is the median over runs of a per-run number, then the range the median plausibly lies
 * in: the 2nd-lowest to 2nd-highest run, which for 10 runs covers the true median about 98% of
 * the time without assuming any distribution. With fewer than 6 runs it is the full range.
 */
import { readFileSync } from 'node:fs'
import { scenarioMetrics, type Metrics, type ScenarioRecord } from './phone-latency-metrics'

const TABLES: { title: string; scenario: string; tabs: string[]; metrics: [string, string][] }[] = [
  {
    title: 'Typing: key press to echo on screen',
    scenario: 'type',
    tabs: ['claude', 'codex'],
    metrics: [
      ['echoP50Ms', 'median ms'],
      ['echoP95Ms', 'p95 ms'],
      ['echoMaxMs', 'worst ms'],
      ['sends', 'sends for 20 keys'],
      ['keysLost', 'keys never echoed']
    ]
  },
  {
    title: 'Watching an answer stream in',
    scenario: 'stream',
    tabs: ['claude', 'codex'],
    metrics: [
      ['firstOutputMs', 'Enter to first output ms'],
      ['freezeP95Ms', 'p95 freeze ms'],
      ['freezeMaxMs', 'longest freeze ms'],
      ['durationMs', 'whole answer ms'],
      ['resumeAfterCutMs', 'resume after cut ms'],
      ['finished', 'finished (1 = yes)']
    ]
  },
  {
    title: 'Long drag, then a tap',
    scenario: 'drag-then-tap',
    tabs: ['claude', 'codex'],
    metrics: [
      ['positionsDrawn', 'positions drawn'],
      ['rowsMoved', 'rows moved'],
      ['largestJumpRows', 'largest jump rows'],
      ['firstMoveMs', 'touch to first move ms'],
      ['settleMs', 'settle after lift ms'],
      ['tapDelivered', 'tap delivered (1 = yes)']
    ]
  },
  {
    title: 'Hard flick',
    scenario: 'hard-flick',
    tabs: ['claude', 'codex', 'pager'],
    metrics: [
      ['positionsDrawn', 'positions drawn'],
      ['rowsMoved', 'rows moved'],
      ['largestJumpRows', 'largest jump rows'],
      ['settleMs', 'settle after lift ms']
    ]
  },
  {
    title: 'Long drag in less (swipe becomes arrow keys)',
    scenario: 'drag',
    tabs: ['pager'],
    metrics: [
      ['positionsDrawn', 'positions drawn'],
      ['rowsMoved', 'rows moved'],
      ['largestJumpRows', 'largest jump rows'],
      ['firstMoveMs', 'touch to first move ms'],
      ['settleMs', 'settle after lift ms']
    ]
  }
]

const records: ScenarioRecord[] = process.argv
  .slice(2)
  .flatMap((file) => readFileSync(file, 'utf8').split('\n'))
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line))

const cells = new Map<string, Metrics[]>()
const profiles: string[] = []
const labels: string[] = []
for (const record of records) {
  const key = [record.label, record.profile, record.tab, record.scenario].join('|')
  cells.set(key, [...(cells.get(key) ?? []), scenarioMetrics(record)])
  if (!profiles.includes(record.profile)) {
    profiles.push(record.profile)
  }
  if (!labels.includes(record.label)) {
    labels.push(record.label)
  }
}

const round = (value: number): string =>
  Number.isNaN(value) ? 'never' : value >= 100 ? value.toFixed(0) : String(+value.toFixed(1))

function cell(runs: Metrics[], metric: string): string {
  const values = runs
    .map((run) => run[metric])
    .filter((value) => value !== undefined)
    .sort((a, b) => (Number.isNaN(a) ? 1 : Number.isNaN(b) ? -1 : a - b))
  if (values.length === 0) {
    return '-'
  }
  const median = values[Math.floor((values.length - 1) / 2)]
  const trim = values.length >= 6 ? 1 : 0
  const low = values[trim]
  const high = values.at(-1 - trim)!
  return low === high ? round(median) : `${round(median)} (${round(low)}–${round(high)})`
}

for (const label of labels) {
  console.log(`# ${label}\n`)
  for (const table of TABLES) {
    for (const tab of table.tabs) {
      const present = profiles.filter((profile) =>
        cells.has([label, profile, tab, table.scenario].join('|'))
      )
      if (present.length === 0) {
        continue
      }
      console.log(`## ${table.title} — ${tab}\n`)
      console.log(
        `| profile | runs (valid) | ${table.metrics.map(([, name]) => name).join(' | ')} |`
      )
      console.log(`|---|---|${table.metrics.map(() => '---').join('|')}|`)
      for (const profile of present) {
        const runs = cells.get([label, profile, tab, table.scenario].join('|'))!
        const valid = runs.filter((run) => run.valid === 1)
        console.log(
          `| ${profile} | ${runs.length} (${valid.length}) | ${table.metrics.map(([metric]) => cell(valid, metric)).join(' | ')} |`
        )
      }
      console.log('')
    }
  }
}
