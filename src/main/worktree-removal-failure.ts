import type { LocalWorktreeFilesystemOptions } from './local-worktree-filesystem'
import { isCheckoutRegistered, isUnregisteredRemovalLeftover } from './worktree-removal-leftover'
import type { WorktreeRemovalFailure, WorktreeRemovalRecord } from './worktree-removal-records'
import { worktreeCheckoutExists } from './worktree-removal-table'

/** Keep the error if Git dropped registration but left the checkout on disk. */
export async function failureLeftByGit(
  record: WorktreeRemovalRecord,
  error: unknown,
  localOptions: LocalWorktreeFilesystemOptions = {}
): Promise<WorktreeRemovalFailure | undefined> {
  if (!(await isCheckoutLeftUnregistered(record, localOptions))) {
    return undefined
  }
  const failure = {
    message: error instanceof Error ? error.message : String(error),
    failedAt: Date.now()
  }
  return failure
}

async function isCheckoutLeftUnregistered(
  record: WorktreeRemovalRecord,
  localOptions: LocalWorktreeFilesystemOptions
): Promise<boolean> {
  if (!(await worktreeCheckoutExists(record.worktreePath, localOptions))) {
    return false
  }
  try {
    return (
      !(await isCheckoutRegistered(record, localOptions)) &&
      (await isUnregisteredRemovalLeftover(record.repoPath, record.worktreePath, localOptions))
    )
  } catch (error) {
    console.warn(`[worktrees] could not list worktrees of ${record.repoPath}`, error)
    // Keep the accepted removal recoverable when its filesystem cannot be inspected.
    return true
  }
}
