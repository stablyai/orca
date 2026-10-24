import { deleteBranchOfUnregisteredWorktree } from './git/worktree-removal'
import { isCheckoutRegistered, isUnregisteredRemovalLeftover } from './worktree-removal-leftover'
import type { WorktreeRemovalFailure, WorktreeRemovalRecord } from './worktree-removal-records'
import { worktreeCheckoutExists } from './worktree-removal-table'

/** Keep the error if Git dropped registration but left the checkout on disk. */
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

/** Finish branch/remote cleanup; the failed record retains the folder for the user to remove. */
async function finishGitSideOfFailedRemoval(
  record: WorktreeRemovalRecord,
  cleanupPushTargetRemote: (() => Promise<void>) | undefined
): Promise<void> {
  try {
    // Repo-wide prune could unregister unrelated checkouts on temporarily unmounted drives.
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
    console.warn(`[worktrees] could not list worktrees of ${record.repoPath}`, error)
    return false
  }
}
