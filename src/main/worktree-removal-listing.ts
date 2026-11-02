import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { areWorktreePathsEqual, canonicalWorktreePath } from './git/worktree-path-comparison'
import { isRecordedCheckout, isUnregisteredRemovalLeftover } from './worktree-removal-leftover'
import type { WorktreeRemovalRecord } from './worktree-removal-records'
import {
  failedWorktreeRemovals,
  finishedWorktreeRemovals,
  pendingWorktreeRemovals,
  persistWorktreeRemovalRecords,
  worktreeCheckoutExists
} from './worktree-removal-table'

/** The removals pending when a listing began to read Git. */
export type PendingWorktreeRemovals = ReadonlyMap<string, WorktreeRemovalRecord>

const NO_PENDING_REMOVALS: PendingWorktreeRemovals = new Map()

/** Keep unregistered removal leftovers visible until the folder disappears or a different checkout replaces it. */
export async function withUnregisteredRemovalCheckouts(
  repoId: string,
  gitWorktrees: GitWorktreeInfo[]
): Promise<GitWorktreeInfo[]> {
  let droppedFailure = false
  const failures = new Map(
    [...failedWorktreeRemovals.values()]
      .filter((record) => record.repoId === repoId)
      .map((record) => [canonicalWorktreePath(record.worktreePath), record] as const)
  )
  gitWorktrees = gitWorktrees.map((row) => {
    const record = failures.get(canonicalWorktreePath(row.path))
    if (!record) {
      return row
    }
    if (isRecordedCheckout(row, record)) {
      return { ...row, removalError: record.failure?.message }
    }
    failedWorktreeRemovals.delete(record.worktreeId)
    droppedFailure = true
    return row
  })
  const unlisted = [...pendingWorktreeRemovals.values(), ...failedWorktreeRemovals.values()].filter(
    (record) =>
      record.repoId === repoId &&
      !gitWorktrees.some((worktree) => areWorktreePathsEqual(worktree.path, record.worktreePath))
  )
  const leftovers: GitWorktreeInfo[] = []
  for (const record of unlisted) {
    const failed = failedWorktreeRemovals.get(record.worktreeId) === record
    if (
      (await worktreeCheckoutExists(record.worktreePath)) &&
      (!failed || (await isUnregisteredRemovalLeftover(record.repoPath, record.worktreePath)))
    ) {
      leftovers.push({
        path: record.worktreePath,
        head: record.head,
        branch: record.branch ? `refs/heads/${record.branch}` : '',
        isBare: false,
        isMainWorktree: false,
        ...(record.failure ? { removalError: record.failure.message } : {})
      })
    } else if (failed) {
      failedWorktreeRemovals.delete(record.worktreeId)
      droppedFailure = true
    }
  }
  if (droppedFailure) {
    void persistWorktreeRemovalRecords()
  }
  return leftovers.length === 0 ? gitWorktrees : [...gitWorktrees, ...leftovers]
}

/** Capture before reading Git so completed deletes cannot reappear from stale rows. */
export function snapshotPendingWorktreeRemovals(): PendingWorktreeRemovals {
  return pendingWorktreeRemovals.size === 0 ? NO_PENDING_REMOVALS : new Map(pendingWorktreeRemovals)
}

/** Older clients cannot read removing markers; omit pending rows they already dropped on acceptance. */
export function projectPendingWorktreeRemovals<
  T extends { hostId?: ExecutionHostId; removing?: true }
>(
  rows: T[],
  idOf: (row: T) => string,
  clientReadsMarker: boolean,
  pendingAtScan: PendingWorktreeRemovals
): T[] {
  if (pendingWorktreeRemovals.size === 0 && pendingAtScan.size === 0) {
    return rows
  }
  const projected: T[] = []
  for (const row of rows) {
    const id = idOf(row)
    const local = row.hostId === undefined || row.hostId === LOCAL_EXECUTION_HOST_ID
    if (local && pendingWorktreeRemovals.has(id)) {
      if (clientReadsMarker) {
        projected.push({ ...row, removing: true })
      }
      continue
    }
    const scanned = local ? pendingAtScan.get(id) : undefined
    // Git was read before deletion finished; do not resurrect the stale row as a failed delete.
    if (!scanned || !finishedWorktreeRemovals.has(scanned)) {
      projected.push(row)
    }
  }
  return projected
}
