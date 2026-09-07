import type { ConnectionLogEntry, ConnectionLogTiming } from '../transport/types'

// Why: a report that only says "connecting for 10s" cannot be triaged. These lines
// turn the per-phase timings the transport now records into the two questions
// support actually asks: which relay dial stage ate the time, and how long the
// client sat in each connection state.
export function summarizeConnectionLogTimings(entries: readonly ConnectionLogEntry[]): string[] {
  const timings = entries.flatMap((entry) => (entry.timing ? [entry.timing] : []))
  const lines: string[] = []
  const dials = groupRelayDials(timings.filter((timing) => timing.kind === 'relay-dial-stage'))
  const latestDial = dials.at(-1)
  if (latestDial) {
    const label =
      dials.length > 1 ? `Relay dial stages (latest of ${dials.length})` : 'Relay dial stages'
    const total = latestDial.reduce((sum, timing) => sum + timing.ms, 0)
    lines.push(
      `${label}: ${latestDial.map(formatStageTiming).join(' · ')} — total ${formatDurationMs(total)}`
    )
  }
  const states = totalPerName(timings.filter((timing) => timing.kind === 'connection-state'))
  if (states.length > 0) {
    lines.push(
      `Connection state dwell: ${states
        .map(
          ({ name, ms, count }) => `${name} ${formatDurationMs(ms)}${count > 1 ? ` ×${count}` : ''}`
        )
        .join(' · ')}`
    )
  }
  return lines
}

// Relay dial stages are strictly ordered and every dial starts in 'opening', so an
// 'opening' timing opens a new group. Reporting only the latest keeps a reconnect
// loop from averaging away the attempt the reporter is complaining about.
function groupRelayDials(timings: readonly ConnectionLogTiming[]): ConnectionLogTiming[][] {
  const dials: ConnectionLogTiming[][] = []
  for (const timing of timings) {
    if (timing.name === 'opening' || dials.length === 0) {
      dials.push([])
    }
    dials.at(-1)!.push(timing)
  }
  return dials
}

function totalPerName(
  timings: readonly ConnectionLogTiming[]
): { name: string; ms: number; count: number }[] {
  const totals = new Map<string, { name: string; ms: number; count: number }>()
  for (const timing of timings) {
    const total = totals.get(timing.name) ?? { name: timing.name, ms: 0, count: 0 }
    total.ms += timing.ms
    total.count += 1
    totals.set(timing.name, total)
  }
  return [...totals.values()]
}

function formatStageTiming(timing: ConnectionLogTiming): string {
  return `${timing.name} ${formatDurationMs(timing.ms)}${timing.complete ? '' : ' (did not finish)'}`
}

function formatDurationMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
