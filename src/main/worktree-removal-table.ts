import { lstat } from 'node:fs/promises'
import { getErrorCode } from './git/worktree-operation-options'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { writeWorktreeRemovalRecords, type WorktreeRemovalRecord } from './worktree-removal-records'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'

// The accepted removals, mirrored to disk on every change; listings and joins read only this.
export const pendingWorktreeRemovals = new Map<string, WorktreeRemovalRecord>()
// Deletes that failed with the checkout still on disk. One Git no longer registers is listed with
// its error until Delete retries it, the checkout disappears or is replaced, or the repo leaves
// Orca; one Git still registers only answers `worktree.removalState` until the next Delete drops
// it. Never retried unasked.
export const failedWorktreeRemovals = new Map<string, WorktreeRemovalRecord>()
// Why weak: a listing that read Git before a delete finished holds the record until it replies.
export const finishedWorktreeRemovals = new WeakSet<WorktreeRemovalRecord>()
let recordsDirectory: string | null = null

export function setWorktreeRemovalRecordsDirectory(directory: string | null): void {
  recordsDirectory = directory
}

export function persistWorktreeRemovalRecords(): Promise<void> {
  if (!recordsDirectory) {
    return Promise.resolve()
  }
  return writeWorktreeRemovalRecords(recordsDirectory, () => [
    ...pendingWorktreeRemovals.values(),
    ...failedWorktreeRemovals.values()
  ]).catch((error: unknown) => {
    // Why: bookkeeping must not gate the delete; a lost write only costs resuming it after a quit.
    console.warn('[worktrees] failed to persist worktree removal records', error)
  })
}

/** Unreadable counts as present: only a checkout proven gone ends a failed delete. */
export async function worktreeCheckoutExists(worktreePath: string): Promise<boolean> {
  try {
    await lstat(worktreePath)
    return true
  } catch (error) {
    const code = getErrorCode(error)
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

/**
 * Delete's choice for a workspace whose earlier delete failed, from Git's listing taken now: a
 * checkout Git registers at the path again is a new one, so the failed record is dropped and the
 * normal delete runs; while Git does not, `retry` runs or joins the recorded removal. True then.
 */
export function retryFailedRemovalUnlessRegistered(
  worktreeId: string,
  worktreePath: string,
  registeredWorktrees: readonly Pick<GitWorktreeInfo, 'path'>[],
  retry: () => Promise<RemoveWorktreeResult> | undefined
): boolean {
  if (registeredWorktrees.some((worktree) => areWorktreePathsEqual(worktree.path, worktreePath))) {
    if (failedWorktreeRemovals.delete(worktreeId)) {
      void persistWorktreeRemovalRecords()
    }
    return false
  }
  return retry() !== undefined
}

export function hasPendingWorktreeRemovals(): boolean {
  return pendingWorktreeRemovals.size > 0
}

export function findPendingWorktreeRemovalConflict(
  repoPath: string,
  target: { worktreePath?: string; branch?: string }
): WorktreeRemovalRecord | undefined {
  const branch = target.branch?.replace(/^refs\/heads\//, '')
  for (const removal of pendingWorktreeRemovals.values()) {
    if (!areWorktreePathsEqual(removal.repoPath, repoPath)) {
      continue
    }
    if (
      (target.worktreePath && areWorktreePathsEqual(removal.worktreePath, target.worktreePath)) ||
      (branch && removal.branch === branch)
    ) {
      return removal
    }
  }
  return undefined
}

export function assertNoPendingWorktreeRemovalConflict(
  repoPath: string,
  target: { worktreePath?: string; branch?: string }
): void {
  const removal = findPendingWorktreeRemovalConflict(repoPath, target)
  if (removal) {
    throw new Error(
      `Orca is still deleting the workspace at ${removal.worktreePath}. Cleanup is pending; try again shortly.`
    )
  }
}
