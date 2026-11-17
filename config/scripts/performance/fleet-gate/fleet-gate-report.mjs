// Turns per-run probe snapshots into the OLD vs NEW rate table and its verdict.

// A metric regresses only when every NEW run is worse than every OLD run by more than rel × OLD + abs.
export const METRICS = [
  { key: 'outPerSec', label: 'M→R msg/s', rel: 0.25, abs: 2 },
  { key: 'inPerSec', label: 'R→M msg/s', rel: 0.25, abs: 2 },
  { key: 'noopOutPerSec', label: 'no-op M→R msg/s', rel: 0.25, abs: 1 },
  { key: 'pubsPerSec', label: 'store pubs/s', rel: 0.25, abs: 5 },
  { key: 'noopPubsPerSec', label: 'no-op store pubs/s', rel: 0.25, abs: 2 },
  { key: 'wakeupsPerSec', label: 'subscriber wakeups/s', rel: 0.25, abs: 500 },
  // Same-build runs differed by up to ~60 ms/s on Xvfb, so smaller long-task deltas are noise.
  { key: 'longTaskMsPerSec', label: 'long tasks ms/s', rel: 0.5, abs: 50 },
  { key: 'stalls100', label: 'main stalls >100ms', rel: 0.5, abs: 3 },
  { key: 'stallMaxMs', label: 'main stall max ms', rel: 1, abs: 250 },
  { key: 'mainHeapMb', label: 'main heap MB', rel: 0.15, abs: 50 },
  { key: 'rendererHeapMb', label: 'renderer heap MB', rel: 0.15, abs: 100 }
]

// An idle fleet has no reason to talk: above these NEW fails unless OLD (main) is already above them.
export const IDLE_CEILINGS = { outPerSec: 10, noopOutPerSec: 2, pubsPerSec: 20, noopPubsPerSec: 5 }

const round = (value) => (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10)

export function windowMetrics(main, renderer, windowMs) {
  const seconds = windowMs / 1_000
  return {
    outPerSec: main.out.n / seconds,
    inPerSec: main.in.n / seconds,
    noopOutPerSec: main.out.noop / seconds,
    pubsPerSec: renderer.pubs / seconds,
    noopPubsPerSec: renderer.noop / seconds,
    wakeupsPerSec: renderer.wakeups / seconds,
    longTaskMsPerSec: renderer.longMs / seconds,
    stalls100: main.stalls100,
    stallMaxMs: main.stallMaxMs,
    mainHeapMb: main.heapUsedMb,
    rendererHeapMb: renderer.heapUsedMb
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length / 2
  return Number.isInteger(middle)
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[Math.floor(middle)]
}

export function compareRuns(runs, scenarios) {
  const rows = []
  for (const scenario of scenarios) {
    for (const metric of METRICS) {
      const values = (arm) =>
        runs
          .filter((run) => run.arm === arm)
          .map((run) => run.windows[scenario]?.metrics?.[metric.key])
          .filter((value) => typeof value === 'number' && Number.isFinite(value))
      const oldValues = values('old')
      const newValues = values('new')
      if (oldValues.length === 0 || newValues.length === 0) {
        rows.push({ scenario, metric, old: null, new: null, verdict: 'n/a' })
        continue
      }
      const oldWorst = Math.max(...oldValues)
      const newBest = Math.min(...newValues)
      let verdict = newBest > oldWorst * (1 + metric.rel) + metric.abs ? 'FAIL' : 'ok'
      const ceiling = scenario === 'idle' ? IDLE_CEILINGS[metric.key] : undefined
      if (verdict === 'ok' && ceiling !== undefined && newBest > ceiling) {
        verdict = Math.min(...oldValues) > ceiling ? 'WARN (main over idle ceiling too)' : 'FAIL'
      }
      rows.push({
        scenario,
        metric,
        old: round(median(oldValues)),
        new: round(median(newValues)),
        verdict
      })
    }
  }
  return rows
}

export function formatTable({ rows, header, notes }) {
  const lines = [header]
  const widths = [10, 22, 10, 10]
  const pad = (text, width) => String(text).padEnd(width)
  lines.push(
    `${pad('scenario', widths[0])}${pad('metric', widths[1])}${pad('OLD', widths[2])}${pad('NEW', widths[3])}verdict`
  )
  for (const row of rows) {
    lines.push(
      `${pad(row.scenario, widths[0])}${pad(row.metric.label, widths[1])}${pad(row.old ?? '—', widths[2])}${pad(row.new ?? '—', widths[3])}${row.verdict}`
    )
  }
  for (const note of notes) {
    lines.push(`note: ${note}`)
  }
  const failures = rows.filter((row) => row.verdict === 'FAIL')
  const missing = rows.filter((row) => row.verdict === 'n/a')
  const result =
    failures.length > 0
      ? `RESULT: FAIL (${failures.map((row) => `${row.scenario} ${row.metric.label}`).join(', ')})`
      : missing.length === rows.length
        ? 'RESULT: FAIL (no measurements)'
        : 'RESULT: PASS'
  lines.push(result)
  return { text: lines.join('\n'), passed: result === 'RESULT: PASS' }
}
