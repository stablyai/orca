import { lstat } from 'node:fs/promises'
import { getErrorCode } from './git/worktree-operation-options'
import { canonicalWorktreePath, areWorktreePathsEqual } from './git/worktree-path-comparison'
import { writeWorktreeRemovalRecords, type WorktreeRemovalRecord } from './worktree-removal-records'

let removalEpoch = 0
const removalRepoRevisions = new Map<string, number>()
function removalMembershipChanged(record: WorktreeRemovalRecord): void {
  removalEpoch++
  removalRepoRevisions.set(record.repoId, removalEpoch)
}

// All lifecycle writers, including load/retry and same-size replacement, invalidate at mutation.
class WorktreeRemovalTable extends Map<string, WorktreeRemovalRecord> {
  override set(key: string, record: WorktreeRemovalRecord): this {
    const previous = this.get(key)
    if (previous) {
      removalMembershipChanged(previous)
    }
    removalMembershipChanged(record)
    return super.set(key, record)
  }
  override delete(key: string): boolean {
    const previous = this.get(key)
    if (previous) {
      removalMembershipChanged(previous)
    }
    return super.delete(key)
  }
  override clear(): void {
    for (const record of this.values()) {
      removalMembershipChanged(record)
    }
    super.clear()
  }
}

export const pendingWorktreeRemovals = new WorktreeRemovalTable()
// Failed leftovers stay visible until gone/replaced or their repo is removed; never retry without a request.
export const failedWorktreeRemovals = new WorktreeRemovalTable()
let indexedRemovalEpoch = -1
const removalPathsByRepo = new Map<string, ReadonlySet<string>>()
const noRemovalPaths: ReadonlySet<string> = new Set()

export function worktreeRemovalMembershipRevision(repoId: string): number {
  return removalRepoRevisions.get(repoId) ?? 0
}

/** One host-local census per consumed epoch; unrelated repo mutations do not invalidate observations. */
export function worktreeRemovalPathsForRepo(repoId: string): ReadonlySet<string> {
  if (indexedRemovalEpoch !== removalEpoch) {
    removalPathsByRepo.clear()
    const paths = new Map<string, Set<string>>()
    for (const table of [pendingWorktreeRemovals, failedWorktreeRemovals]) {
      for (const record of table.values()) {
        const partition = paths.get(record.repoId) ?? new Set<string>()
        partition.add(canonicalWorktreePath(record.worktreePath))
        paths.set(record.repoId, partition)
      }
    }
    for (const [id, partition] of paths) {
      removalPathsByRepo.set(id, partition)
    }
    indexedRemovalEpoch = removalEpoch
  }
  return removalPathsByRepo.get(repoId) ?? noRemovalPaths
}
// In-flight listings retain completed records only until their stale Git read is projected.
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
