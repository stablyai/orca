import type { WorktreePreparationOperation } from './worktree-preparation-operation'
import { windowsLongPathGitArgs } from '../../../../shared/windows-long-path-git-args'
import { checkoutWorkersGitArgs } from './checkout-workers-git-args'
import { withRepoRefMaintenancePaused } from '../../refs/maintenance/local-repo-ref-maintenance'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { runWithGitReadCacheInvalidation } from '../../source-control/git-read-cache-invalidation'
import { bumpWorktreeScanGeneration as notifyPreparedWorktreeMutation } from '../catalog/worktree-scan-cache'
import {
  gitExecOptions,
  resolveWorktreeAddTimeoutMs,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'
import {
  verifyWorktreePreparationLock,
  verifyWorktreePreparationLockAtPath
} from './worktree-preparation-lock'

export async function refreshPreparedWorktreeTip(
  repoPath: string,
  preparedPath: string,
  canonicalBase: string,
  lockReason: string,
  options: GitWorktreeExecOptions = {},
  operation?: WorktreePreparationOperation
): Promise<void> {
  const refreshOptions = {
    ...(operation?.executionOptions() ?? options),
    timeout: options.timeout ?? resolveWorktreeAddTimeoutMs()
  }
  const run = async (): Promise<void> => {
    const lockPath = await verifyWorktreePreparationLock(preparedPath, lockReason, refreshOptions)
    const [target, prepared] = await Promise.allSettled([
      gitExecFileAsync(
        ['rev-parse', '--verify', `${canonicalBase}^{commit}`],
        gitExecOptions(repoPath, refreshOptions)
      ),
      gitExecFileAsync(
        ['rev-parse', '--verify', 'HEAD'],
        gitExecOptions(preparedPath, refreshOptions)
      )
    ])
    if (target.status === 'rejected') {
      throw target.reason
    }
    if (prepared.status === 'rejected') {
      throw prepared.reason
    }
    await verifyWorktreePreparationLockAtPath(lockPath, lockReason, refreshOptions.signal)
    const targetHead = target.value.stdout.trim()
    if (prepared.value.stdout.trim() === targetHead) {
      return
    }
    const checkoutWorkersArgs = await checkoutWorkersGitArgs(preparedPath, refreshOptions)
    refreshOptions.signal?.throwIfAborted()
    if (operation?.isClaimed) {
      return
    }
    try {
      // Reset preserves detached HEAD and does not run post-checkout hooks before submit.
      await runWithGitReadCacheInvalidation(() =>
        gitExecFileAsync(
          [
            ...checkoutWorkersArgs,
            ...windowsLongPathGitArgs(preparedPath),
            'reset',
            '--hard',
            targetHead
          ],
          gitExecOptions(preparedPath, refreshOptions)
        )
      )
      await verifyWorktreePreparationLockAtPath(lockPath, lockReason, refreshOptions.signal)
    } finally {
      notifyPreparedWorktreeMutation(repoPath)
    }
  }
  await (operation
    ? operation.withMaintenancePaused(run)
    : withRepoRefMaintenancePaused('worktree-prepare', run))
}
