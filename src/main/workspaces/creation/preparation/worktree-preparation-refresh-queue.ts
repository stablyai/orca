import { worktreePreparationGit } from '../../../git/worktrees/creation/worktree-create-git-executor'
import { refreshPreparedWorktreeTip } from '../../../git/worktrees/creation/worktree-preparation-tip-refresh'
import { WorktreePreparationLockOwnershipError } from '../../../git/worktrees/creation/worktree-preparation-lock'
import type { PreparationEntry } from './worktree-create-preparation-pool'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'

/** Publish the refresh before yielding so a racing create waits for the same checkout. */
export function queuePreparedWorktreeTipRefresh(
  entry: PreparationEntry,
  retire: () => void,
  beforeMaterialization?: Promise<void>
): Promise<void> {
  const signal = entry.options.signal
    ? AbortSignal.any([entry.options.signal, entry.controller.signal])
    : entry.controller.signal
  const ready = entry.ready.then(async () => {
    signal.throwIfAborted()
    if (beforeMaterialization) {
      await waitForPromiseWithSignal(beforeMaterialization, signal)
    }
    return worktreePreparationGit.run(() =>
      refreshPreparedWorktreeTip(
        entry.repoPath,
        entry.preparedPath,
        entry.canonicalBase,
        entry.lockReason,
        {
          ...entry.options,
          signal
        }
      )
    )
  })
  entry.ready = ready
  void ready.catch((error: unknown) => {
    if (error instanceof WorktreePreparationLockOwnershipError) {
      entry.checkoutStarted = false
    }
    retire()
  })
  return ready
}
