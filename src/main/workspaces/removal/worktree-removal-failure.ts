import { deleteBranchOfUnregisteredWorktree } from '../../git/worktrees/removal/worktree-removal'
import {
  isRecordedCheckout,
  registeredRemovalCheckout,
  isUnregisteredRemovalLeftover
} from './worktree-removal-leftover'
import type { WorktreeRemovalFailure, WorktreeRemovalRecord } from './worktree-removal-records'
import { worktreeCheckoutExists } from './worktree-removal-table'

/** Keep the branch and push target until a retry removes the folder, so a half-done delete loses nothing. */
export async function failureLeftByGit(
  record: WorktreeRemovalRecord,
  error: unknown
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
  let kept: WorktreeRemovalFailure | undefined
  try {
    const registered = await registeredRemovalCheckout(record)
    if (registered) {
      kept = isRecordedCheckout(registered, record) ? { ...failure, message } : undefined
    } else {
      kept = (await isUnregisteredRemovalLeftover(record.repoPath, record.worktreePath))
        ? failure
        : undefined
    }
  } catch (error) {
    console.warn(`[worktrees] could not inspect failed removal of ${record.worktreePath}`, error)
    return failure
  }
  if (!kept) {
    await deleteBranchOfReplacedRemoval(record)
  }
  return kept
}

/** Another checkout now holds the path, so the old folder is gone; `-d` still keeps unmerged work. */
export async function deleteBranchOfReplacedRemoval(record: WorktreeRemovalRecord): Promise<void> {
  if (!record.deleteBranch || !record.branch) {
    return
  }
  try {
    await deleteBranchOfUnregisteredWorktree(record.repoPath, record.worktreePath, {
      name: record.branch,
      head: record.head
    })
  } catch (error) {
    console.warn(`[worktrees] could not delete the branch of ${record.worktreePath}`, error)
  }
}
