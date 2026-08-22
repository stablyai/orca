import type { FleetEcho, FleetLaneRow } from '../../shared/orchestration-fleet-echo'

// Why: a coordinator scans this at a glance; "12s"/"6m41s" reads faster than raw ms.
function formatDurationMs(durationMs: number | null): string {
  if (durationMs === null) {
    return '—'
  }
  const totalSeconds = Math.floor(durationMs / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m${seconds}s`
}

// Why: NOT_ACCEPTED is the one value a coordinator must not skim past — the whole reason the block
// exists. The basis rides in the same cell because a verdict and how much it is worth are one fact:
// ':stage' was read from the worker row, ':output' was inferred from the terminal having stayed quiet.
function formatDelivery(lane: Pick<FleetLaneRow, 'delivery' | 'deliveryEvidence'>): string {
  const verdict = lane.delivery === 'not_accepted' ? 'NOT_ACCEPTED' : lane.delivery
  if (lane.deliveryEvidence === null) {
    return verdict
  }
  return `${verdict}:${lane.deliveryEvidence === 'worker_stage' ? 'stage' : 'output'}`
}

function padColumn(value: string, width: number): string {
  return value.padEnd(width)
}

// Why: a healthy fleet says the same thing on every run-scoped response, and this block rides on
// all of them — repeating an unchanged table costs a coordinator context on every call. One line
// when there is nothing to act on makes the table itself the signal that something needs looking at.
function isHealthy(lane: FleetLaneRow): boolean {
  return lane.delivery !== 'not_accepted' && lane.processState !== 'dead'
}

function formatHealthySummary(fleet: FleetEcho, laneWord: string): string {
  const quietest = fleet.lanes.reduce<number | null>(
    (worst, lane) => (lane.quietMs !== null && lane.quietMs > (worst ?? -1) ? lane.quietMs : worst),
    null
  )
  const truncatedNote = fleet.truncated ? ', more not shown' : ''
  return `fleet ${fleet.runId}: ${fleet.lanes.length} ${laneWord}, none needing attention, quietest ${formatDurationMs(quietest)}${truncatedNote}`
}

export function formatFleetEcho(fleet: FleetEcho): string {
  if (fleet.lanes.length === 0) {
    return ''
  }
  const laneWord = fleet.lanes.length === 1 ? 'lane' : 'lanes'
  if (fleet.lanes.every(isHealthy)) {
    return formatHealthySummary(fleet, laneWord)
  }

  const rows = fleet.lanes.map((lane) => ({
    handle: lane.handle ?? '—',
    taskId: lane.taskId,
    dispatchId: lane.dispatchId,
    quietMs: formatDurationMs(lane.quietMs),
    // Why: labelled rather than a bare second duration — two unlabelled ages side by side
    // read as one range. "hb:—" says the lane has never heartbeated, not that it is silent.
    heartbeat: `hb:${formatDurationMs(lane.heartbeatAgeMs)}`,
    delivery: formatDelivery(lane),
    // Why: a live PTY proves nothing about the agent inside it, so only dead/unknown earn a call-out.
    // 'live' is unreachable on this build (the runtime never emits it, see skill-guides/orchestration.md)
    // but stays handled since it's a valid FleetLaneProcessState member and the renderer must stay total.
    processStateTag: lane.processState === 'live' ? '' : ` (${lane.processState})`
  }))

  const widths = {
    handle: Math.max(...rows.map((row) => row.handle.length)),
    taskId: Math.max(...rows.map((row) => row.taskId.length)),
    dispatchId: Math.max(...rows.map((row) => row.dispatchId.length)),
    quietMs: Math.max(...rows.map((row) => row.quietMs.length)),
    heartbeat: Math.max(...rows.map((row) => row.heartbeat.length))
  }

  const lines = rows.map(
    (row) =>
      `  ${padColumn(row.handle, widths.handle)}  ${padColumn(row.taskId, widths.taskId)}  ` +
      `${padColumn(row.dispatchId, widths.dispatchId)}  ` +
      `${padColumn(row.quietMs, widths.quietMs)}  ${padColumn(row.heartbeat, widths.heartbeat)}  ` +
      `${row.delivery}${row.processStateTag}`
  )

  const header = `fleet ${fleet.runId} (${fleet.lanes.length} ${laneWord}):`
  const footer = fleet.truncated ? ['  … more lanes not shown'] : []

  return [header, ...lines, ...footer].join('\n')
}
