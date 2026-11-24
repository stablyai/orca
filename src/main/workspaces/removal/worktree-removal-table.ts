import { WorktreeRemovalReservations } from './worktree-removal-reservations'
import { lstat } from 'node:fs/promises'
import { getErrorCode } from '../../git/worktrees/worktree-operation-options'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import {
  writeWorktreeRemovalRecords,
  worktreeRemovalRecordsFile,
  type WorktreeRemovalRecord
} from './worktree-removal-records'
import { withSidecarSnapshotQueue } from '../../filesystem/sidecar-snapshot-file'

export const pendingWorktreeRemovals = new WorktreeRemovalReservations()
export const recordedWorktreeRemovals = new WeakSet<WorktreeRemovalRecord>()
// Failed leftovers stay visible until gone/replaced or their repo is removed; never retry without a request.
export const failedWorktreeRemovals = new Map<string, WorktreeRemovalRecord>()
// In-flight listings retain completed records only until their stale Git read is projected.
export const finishedWorktreeRemovals = new WeakSet<WorktreeRemovalRecord>()
let recordsDirectory: string | null = null

export function setWorktreeRemovalRecordsDirectory(directory: string | null): void {
  recordsDirectory = directory
}

export function closeWorktreeRemovalRecords(): Promise<void> {
  const directory = recordsDirectory
  recordsDirectory = null
  return directory
    ? withSidecarSnapshotQueue(worktreeRemovalRecordsFile(directory), async () => {})
    : Promise.resolve()
}

export function persistWorktreeRemovalRecords(): Promise<void> {
  if (!recordsDirectory) {
    return Promise.resolve()
  }
  return writeWorktreeRemovalRecords(recordsDirectory, journalRecords).catch((error: unknown) => {
    console.warn('[worktrees] failed to persist worktree removal records', error)
  })
}

function journalRecords(candidate?: WorktreeRemovalRecord): WorktreeRemovalRecord[] {
  const records = new Map(failedWorktreeRemovals)
  for (const record of pendingWorktreeRemovals.values()) {
    if (recordedWorktreeRemovals.has(record)) {
      records.set(record.worktreeId, record)
    }
  }
  if (candidate) {
    records.set(candidate.worktreeId, candidate)
  }
  return [...records.values()]
}

/** Commit only this admission; unrelated reservations must never reach a restart's journal. */
export function recordWorktreeRemoval(record: WorktreeRemovalRecord): Promise<void> {
  if (!recordsDirectory) {
    return Promise.reject(
      new Error('Could not start deletion. Reopen the workspace and try again.')
    )
  }
  return writeWorktreeRemovalRecords(
    recordsDirectory,
    () => journalRecords(record),
    () => {
      recordedWorktreeRemovals.add(record)
      failedWorktreeRemovals.delete(record.worktreeId)
    }
  )
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
  for (const removal of [...pendingWorktreeRemovals.values(), ...failedWorktreeRemovals.values()]) {
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
      removal.failure
        ? `Cleanup failed for the workspace at ${removal.worktreePath}. Retry deleting it before reusing its path or branch.`
        : `Orca is still deleting the workspace at ${removal.worktreePath}. Cleanup is pending; try again shortly.`
    )
  }
}
