import type { DescendantSnapshot, ProcessTableRow } from './pty-descendant-termination'

export function hasUnambiguousStartIdentity(row: ProcessTableRow, capturedAtMs: number): boolean {
  return hasUnambiguousStartTime(row.startedAt, capturedAtMs)
}

export function hasUnambiguousStartTime(startedAt: string, capturedAtMs: number): boolean {
  const startedAtMs = Date.parse(startedAt)
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(capturedAtMs)) {
    return false
  }
  // ps lstart is second-resolution. A process born in the capture second can
  // be replaced by a different process with the same displayed timestamp.
  return startedAtMs < Math.floor(capturedAtMs / 1_000) * 1_000
}

/** Reject ambiguous identities in either the original snapshot or the fresh table. */
export function matchingSignalTargets(
  snapshot: DescendantSnapshot,
  table: ProcessTableRow[]
): ProcessTableRow[] {
  const expected = new Map<number, ProcessTableRow | null>()
  for (const row of snapshot.descendants) {
    expected.set(row.pid, expected.has(row.pid) ? null : row)
  }
  const liveTargets = new Map<number, ProcessTableRow | null>()
  for (const live of table) {
    if (expected.has(live.pid)) {
      liveTargets.set(live.pid, liveTargets.has(live.pid) ? null : live)
    }
  }
  return [...expected.values()].filter((row): row is ProcessTableRow => {
    if (!row || !Number.isInteger(row.pid) || row.pid <= 0) {
      return false
    }
    const live = liveTargets.get(row.pid)
    return (
      hasUnambiguousStartIdentity(
        row,
        snapshot.capturedAtMsByPid?.[String(row.pid)] ?? snapshot.capturedAtMs
      ) &&
      live?.startedAt === row.startedAt &&
      live.pgid === row.pgid
    )
  })
}
