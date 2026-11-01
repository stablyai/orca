import type { DescendantSnapshot } from '../pty-descendant-termination'

// Non-atomic scans may omit live rows; retain them, but reject any PID whose identity changed.
function mergeRowsByPid<Row extends { pid: number }>(
  previous: readonly Row[],
  next: readonly Row[],
  sameIdentity: (previous: Row, next: Row) => boolean,
  previousBoundary: (row: Row) => number,
  nextBoundary: (row: Row) => number,
  refreshBoundary: number
): { rows: Row[]; capturedAtMsByPid?: Readonly<Record<string, number>> } | null {
  const merged = new Map<number, Row>()
  const capturedAtMsByPid: Record<string, number> = {}
  for (const row of previous) {
    const prior = merged.get(row.pid)
    if (prior && !sameIdentity(prior, row)) {
      return null
    }
    merged.set(row.pid, row)
    capturedAtMsByPid[String(row.pid)] = previousBoundary(row)
  }
  for (const row of next) {
    const prior = merged.get(row.pid)
    if (prior && !sameIdentity(prior, row)) {
      return null
    }
    if (!prior) {
      capturedAtMsByPid[String(row.pid)] = nextBoundary(row)
    }
    merged.set(row.pid, row)
  }
  const boundaries = Object.values(capturedAtMsByPid)
  const needsBoundaryMap =
    new Set(boundaries).size > 1 || boundaries.some((boundary) => boundary !== refreshBoundary)
  return {
    rows: [...merged.values()],
    ...(needsBoundaryMap ? { capturedAtMsByPid } : {})
  }
}

export function mergeClaudeDescendantSnapshots(
  previous: DescendantSnapshot,
  next: DescendantSnapshot
): DescendantSnapshot | null {
  if (previous.rootPgid !== next.rootPgid) {
    return null
  }
  // New root identity cannot validate rows retained without identity evidence.
  if (!previous.root || !next.root) {
    return null
  }
  if (previous.root.pid !== next.root.pid || previous.root.startedAt !== next.root.startedAt) {
    return null
  }
  const descendants = mergeRowsByPid(
    previous.descendants,
    next.descendants,
    (left, right) => left.pgid === right.pgid && left.startedAt === right.startedAt,
    (row) => previous.capturedAtMsByPid?.[String(row.pid)] ?? previous.capturedAtMs,
    (row) => next.capturedAtMsByPid?.[String(row.pid)] ?? next.capturedAtMs,
    next.capturedAtMs
  )
  if (!descendants) {
    return null
  }
  return {
    ...next,
    // Retained rows keep their first capture boundary; the scalar stays current for legacy consumers.
    descendants: descendants.rows,
    ...(descendants.capturedAtMsByPid ? { capturedAtMsByPid: descendants.capturedAtMsByPid } : {})
  }
}
