import type { DescendantSnapshot } from '../pty-descendant-termination'
import type { WindowsDescendantSnapshot } from '../windows-descendant-exit-verification'

/** One platform's descendant tree, tagged so neither verifier can be handed the other's rows. */
export type ClaudeCapturedTree =
  | { platform: 'posix'; tree: DescendantSnapshot }
  | { platform: 'win32'; tree: WindowsDescendantSnapshot }

/**
 * Process-table reads are not atomic: a refresh can omit a still-live row, but
 * it can also observe a new process after the old row exited. Retain rows absent
 * from the refresh, but reject a PID whose identity changed between reads.
 */
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

export function mergeClaudeCapturedTrees(
  previous: ClaudeCapturedTree,
  next: ClaudeCapturedTree
): ClaudeCapturedTree | null {
  if (previous.platform !== next.platform) {
    return null
  }
  if (previous.platform === 'posix' && next.platform === 'posix') {
    if (previous.tree.rootPgid !== next.tree.rootPgid) {
      return null
    }
    // A refresh cannot repair an earlier capture that lacked root identity;
    // retaining those rows would permit a later numeric-pid kill without proof.
    if (!previous.tree.root || !next.tree.root) {
      return null
    }
    if (
      previous.tree.root.pid !== next.tree.root.pid ||
      previous.tree.root.startedAt !== next.tree.root.startedAt
    ) {
      return null
    }
    const descendants = mergeRowsByPid(
      previous.tree.descendants,
      next.tree.descendants,
      (left, right) => left.pgid === right.pgid && left.startedAt === right.startedAt,
      (row) => previous.tree.capturedAtMsByPid?.[String(row.pid)] ?? previous.tree.capturedAtMs,
      (row) => next.tree.capturedAtMsByPid?.[String(row.pid)] ?? next.tree.capturedAtMs,
      next.tree.capturedAtMs
    )
    if (!descendants) {
      return null
    }
    return {
      platform: 'posix',
      tree: {
        ...next.tree,
        // Retained rows keep their earlier boundary; new rows use the refresh
        // boundary. The scalar remains the latest scan for legacy consumers.
        descendants: descendants.rows,
        ...(descendants.capturedAtMsByPid
          ? { capturedAtMsByPid: descendants.capturedAtMsByPid }
          : {})
      }
    }
  }
  if (previous.platform === 'win32' && next.platform === 'win32') {
    if (
      previous.tree.root.pid !== next.tree.root.pid ||
      previous.tree.root.creationTimeMs !== next.tree.root.creationTimeMs
    ) {
      return null
    }
    const descendants = mergeRowsByPid(
      previous.tree.descendants,
      next.tree.descendants,
      (left, right) => left.creationTimeMs === right.creationTimeMs,
      (row) => previous.tree.capturedAtMsByPid?.[String(row.pid)] ?? previous.tree.capturedAtMs,
      (row) => next.tree.capturedAtMsByPid?.[String(row.pid)] ?? next.tree.capturedAtMs,
      next.tree.capturedAtMs
    )
    if (!descendants) {
      return null
    }
    return {
      platform: 'win32',
      tree: {
        ...next.tree,
        descendants: descendants.rows,
        ...(descendants.capturedAtMsByPid
          ? { capturedAtMsByPid: descendants.capturedAtMsByPid }
          : {}),
        unidentifiedCount: Math.max(previous.tree.unidentifiedCount, next.tree.unidentifiedCount)
      }
    }
  }
  return null
}
