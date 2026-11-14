import { deleteBranchOfUnregisteredWorktree } from '../../git/worktrees/removal/worktree-removal'
import {
  isRecordedCheckout,
  registeredRemovalCheckout,
  isUnregisteredRemovalLeftover
} from './worktree-removal-leftover'
import type { WorktreeRemovalFailure, WorktreeRemovalRecord } from './worktree-removal-records'
import { worktreeCheckoutExists } from './worktree-removal-table'

/** Retain failures for the same checkout without cleaning up its live Git ownership. */
export async function failureLeftByGit(
  record: WorktreeRemovalRecord,
  error: unknown,
  cleanupPushTargetRemote: (() => Promise<void>) | undefined
): Promise<WorktreeRemovalFailure | undefined> {
  const message = error instanceof Error ? error.message : String(error)
  const failure = {
    message: message.replace(
      / Close (?:that program|any program using it) and delete again\.$/,
      () =>
        ` Close any program using it, then retry deletion. If you removed the folder at ${record.worktreePath} yourself, retry deletion to finish cleanup.`
    ),
    failedAt: Date.now()
  }
  if (!(await worktreeCheckoutExists(record.worktreePath))) {
    return failure
  }
  try {
    const registered = await registeredRemovalCheckout(record)
    if (registered) {
      return isRecordedCheckout(registered, record) ? { ...failure, message } : undefined
    }
    if (!(await isUnregisteredRemovalLeftover(record.repoPath, record.worktreePath))) {
      return undefined
    }
  } catch (error) {
    console.warn(`[worktrees] could not inspect failed removal of ${record.worktreePath}`, error)
    return failure
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
