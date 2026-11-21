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
          // An undriven window's numbers are kept for diagnosis but never judged.
          .filter((run) => !run.windows[scenario]?.undriven)
          .map((run) => run.windows[scenario]?.metrics?.[metric.key])
          .filter((value) => typeof value === 'number' && Number.isFinite(value))
      const oldValues = values('old')
      const newValues = values('new')
      const scheduled = (arm) => runs.filter((run) => run.arm === arm).length
      // Every scheduled run must have a sample: a dropped NEW run could be the regressed one.
      if (oldValues.length < scheduled('old') || newValues.length < scheduled('new')) {
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

/** Launch bursts are absolute and run on NEW only: any chat that doesn't start fails. */
export function burstRows(bursts) {
  if (bursts.length === 0) {
    return []
  }
  const newBurst = bursts.find((burst) => burst.arm === 'new')
  const metrics = [
    {
      phase: 'mid-turn',
      label: 'mid-turn chats quit',
      read: (burst) => burst.midTurnLaunched,
      bad: (burst) =>
        !(burst.midTurn?.requested > 0) ||
        burst.midTurnLaunched < burst.midTurn.requested ||
        (burst.midTurn.refused?.length ?? 0) > 0
    },
    {
      // Every chat that quit mid-turn must be offered again; a partial resume is the regression this guards.
      phase: 'mid-turn',
      label: 'restart offers',
      read: (burst) => burst.continuation?.offered,
      bad: (burst) => (burst.continuation?.offered ?? 0) < (burst.midTurn?.requested ?? 1)
    },
    {
      phase: 'mid-turn',
      label: 'continuations started',
      read: (burst) => burst.continuationLaunched,
      bad: (burst) =>
        burst.continuationLaunched < (burst.continuation?.offered ?? 0) ||
        (burst.continuation?.problems?.length ?? 0) > 0
    },
    {
      phase: 'cold',
      label: 'cold launches started',
      read: (burst) => burst.coldLaunched,
      bad: (burst) =>
        burst.coldLaunched < (burst.cold?.requested ?? 0) || (burst.cold?.refused?.length ?? 0) > 0
    },
    {
      label: 'ownership refusals',
      read: (burst) => burst.ownershipRefusals,
      bad: (burst) => burst.ownershipRefusals > 0
    }
  ]
  return metrics.map((metric) => {
    // A phase whose batch couldn't be filled has no workload to judge: its rows are n/a (INCOMPLETE), never FAIL.
    // Rows of a full phase, and ownership refusals, are still judged.
    if (metric.phase && newBurst?.undersizedPhases?.includes(metric.phase)) {
      return {
        scenario: 'burst',
        metric: { label: metric.label },
        old: null,
        new: metric.read(newBurst) ?? '—',
        verdict: 'n/a'
      }
    }
    return {
      scenario: 'burst',
      metric: { label: metric.label },
      old: null,
      new: newBurst ? (metric.read(newBurst) ?? '—') : null,
      verdict: !newBurst ? 'n/a' : metric.bad(newBurst) ? 'FAIL' : 'ok'
    }
  })
}

/** result is PASS, FAIL, or INCOMPLETE when a requested workload or probe didn't run (never a silent PASS). */
export function formatTable({ rows, header, notes, incomplete = [] }) {
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
  for (const reason of incomplete) {
    lines.push(`incomplete: ${reason}`)
  }
  const failures = rows.filter((row) => row.verdict === 'FAIL')
  const missing = rows.filter((row) => row.verdict === 'n/a')
  const result =
    failures.length > 0
      ? 'FAIL'
      : incomplete.length > 0 || missing.length > 0
        ? 'INCOMPLETE'
        : 'PASS'
  const detail =
    result === 'FAIL'
      ? ` (${failures.map((row) => `${row.scenario} ${row.metric.label}`).join(', ')})`
      : result === 'INCOMPLETE'
        ? ` (${String(incomplete.length + missing.length)} workload, probe or metric gap(s) above)`
        : ''
  lines.push(`RESULT: ${result}${detail}`)
  return { text: lines.join('\n'), result }
}
