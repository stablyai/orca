import { worktreePreparationGit } from '../../../git/worktrees/creation/worktree-create-git-executor'
import { refreshPreparedWorktreeTip } from '../../../git/worktrees/creation/worktree-preparation-tip-refresh'
import { WorktreePreparationLockOwnershipError } from '../../../git/worktrees/creation/worktree-preparation-lock'
import type { PreparationEntry } from './worktree-create-preparation-pool'

/** Publish the refresh before yielding so a racing create waits for the same checkout. */
export function queuePreparedWorktreeTipRefresh(
  entry: PreparationEntry,
  retire: () => void,
  beforeMaterialization?: Promise<void>
): Promise<void> {
  const { operation } = entry
  const ready = operation.run(async () => {
    if (beforeMaterialization) {
      await operation.waitForMaterialization(beforeMaterialization)
    }
    if (operation.isClaimed) {
      return
    }
    try {
      return await worktreePreparationGit.run(() =>
        refreshPreparedWorktreeTip(
          entry.repoPath,
          entry.preparedPath,
          entry.canonicalBase,
          entry.lockReason,
          entry.options,
          operation
        )
      )
    } catch (error) {
      if (error instanceof WorktreePreparationLockOwnershipError) {
        entry.checkoutStarted = false
      }
      throw error
    }
  }, true)
  entry.ready = ready
  void ready.catch(() => retire())
  return ready
}
