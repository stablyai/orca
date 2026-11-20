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
  try {
    const registered = await registeredRemovalCheckout(record)
    if (registered) {
      return isRecordedCheckout(registered, record) ? { ...failure, message } : undefined
    }
    return (await isUnregisteredRemovalLeftover(record.repoPath, record.worktreePath))
      ? failure
      : undefined
  } catch (error) {
    console.warn(`[worktrees] could not inspect failed removal of ${record.worktreePath}`, error)
    return failure
  }
}
