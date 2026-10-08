import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { isUnregisteredRemovalLeftover } from './worktree-removal-leftover'
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

/**
 * Git's rows for a local repo plus one for each removal this host still owns whose checkout Git no
 * longer lists but is still on disk: a failed delete (carrying its error) or one still finishing.
 * A failed delete ends here once its checkout is gone or a different checkout took the path.
 */
export async function withUnregisteredRemovalCheckouts(
  repoId: string,
  gitWorktrees: GitWorktreeInfo[]
): Promise<GitWorktreeInfo[]> {
  const unlisted = [...pendingWorktreeRemovals.values(), ...failedWorktreeRemovals.values()].filter(
    (record) =>
      record.repoId === repoId &&
      !gitWorktrees.some((worktree) => areWorktreePathsEqual(worktree.path, record.worktreePath))
  )
  if (unlisted.length === 0) {
    return gitWorktrees
  }
  const leftovers: GitWorktreeInfo[] = []
  let droppedFailure = false
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

/** Taken before a listing reads Git; pass it to projectPendingWorktreeRemovals with the rows. */
export function snapshotPendingWorktreeRemovals(): PendingWorktreeRemovals {
  return pendingWorktreeRemovals.size === 0 ? NO_PENDING_REMOVALS : new Map(pendingWorktreeRemovals)
}

/**
 * Marks rows whose checkout this host is deleting, or leaves them out for a client that cannot
 * read the marker: such a client already dropped the row on acceptance and would re-show it.
 */
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
    // Why: Git was read before this delete finished; unmarked, the gone row reads as a failed delete.
    if (!scanned || !finishedWorktreeRemovals.has(scanned)) {
      projected.push(row)
    }
  }
  return projected
}
