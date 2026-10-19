import { deleteBranchOfUnregisteredWorktree } from './git/worktree-removal'
import { isCheckoutRegistered, isUnregisteredRemovalLeftover } from './worktree-removal-leftover'
import type { WorktreeRemovalFailure, WorktreeRemovalRecord } from './worktree-removal-records'
import { worktreeCheckoutExists } from './worktree-removal-table'

/**
 * The failure to keep for a delete that failed after Git dropped the registration with the
 * checkout still on disk, once the rest of the delete's Git side ran; undefined otherwise.
 */
export async function failureLeftByGit(
  record: WorktreeRemovalRecord,
  error: unknown,
  cleanupPushTargetRemote: (() => Promise<void>) | undefined
): Promise<WorktreeRemovalFailure | undefined> {
  if (!(await isCheckoutLeftUnregistered(record))) {
    return undefined
  }
  const failure = {
    message: error instanceof Error ? error.message : String(error),
    failedAt: Date.now()
  }
  await finishGitSideOfFailedRemoval(record, cleanupPushTargetRemote)
  return failure
}

/**
 * What the delete's finish would have done once Git let go of the checkout, run in the same
 * operation: the branch per the recorded choice and the push-target remote. Deletes no files, so
 * the failed record owes only the folder, which the user removes.
 */
async function finishGitSideOfFailedRemoval(
  record: WorktreeRemovalRecord,
  cleanupPushTargetRemote: (() => Promise<void>) | undefined
): Promise<void> {
  // Why caught: bookkeeping; the failed row and the request's error stand either way.
  try {
    // No prune: Git already dropped this entry; a repo-wide prune would unregister any other
    // worktree whose folder is missing for now (an unmounted drive).
    await deleteBranchOfUnregisteredWorktree(
      record.repoPath,
      record.worktreePath,
      record.deleteBranch && record.branch ? { name: record.branch, head: record.head } : null
    )
  } catch (error) {
    console.warn(`[worktrees] could not delete the branch of ${record.worktreePath}`, error)
  }
  try {
    await cleanupPushTargetRemote?.()
  } catch (error) {
    console.warn(`[worktrees] could not clean up the push target of ${record.worktreePath}`, error)
  }
}

async function isCheckoutLeftUnregistered(record: WorktreeRemovalRecord): Promise<boolean> {
  if (!(await worktreeCheckoutExists(record.worktreePath))) {
    return false
  }
  try {
    return (
      !(await isCheckoutRegistered(record)) &&
      (await isUnregisteredRemovalLeftover(record.repoPath, record.worktreePath))
    )
  } catch (error) {
    // Unknowable: the row stays however Git lists it, as before this record existed.
    console.warn(`[worktrees] could not list worktrees of ${record.repoPath}`, error)
    return false
  }
}
