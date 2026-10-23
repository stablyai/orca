import { lstat } from 'node:fs/promises'
import { getErrorCode } from './git/worktree-operation-options'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { writeWorktreeRemovalRecords, type WorktreeRemovalRecord } from './worktree-removal-records'

// The accepted removals, mirrored to disk on every change; listings and joins read only this.
export const pendingWorktreeRemovals = new Map<string, WorktreeRemovalRecord>()
// Deletes that failed after Git dropped the registration: listed with their error until the
// checkout disappears or is replaced, Delete finds Git registering it, or the repo leaves Orca.
// Never retried unasked.
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
