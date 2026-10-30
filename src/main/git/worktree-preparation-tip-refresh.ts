import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { withRepoRefMaintenancePaused } from './local-repo-ref-maintenance'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import { notifyPreparedWorktreeMutation } from './worktree'
import {
  gitExecOptions,
  resolveWorktreeAddTimeoutMs,
  type GitWorktreeExecOptions
} from './worktree-operation-options'
import {
  verifyWorktreePreparationLock,
  verifyWorktreePreparationLockAtPath
} from './worktree-preparation-lock'

export async function refreshPreparedWorktreeTip(
  repoPath: string,
  preparedPath: string,
  canonicalBase: string,
  lockReason: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  const refreshOptions = { ...options, timeout: options.timeout ?? resolveWorktreeAddTimeoutMs() }
  await withRepoRefMaintenancePaused('worktree-prepare', async () => {
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
    try {
      // Reset preserves detached HEAD and does not run post-checkout hooks before submit.
      await runWithGitReadCacheInvalidation(() =>
        gitExecFileAsync(
          [...windowsLongPathGitArgs(preparedPath), 'reset', '--hard', targetHead],
          gitExecOptions(preparedPath, refreshOptions)
        )
      )
      await verifyWorktreePreparationLockAtPath(lockPath, lockReason, refreshOptions.signal)
    } finally {
      notifyPreparedWorktreeMutation(repoPath)
    }
  })
}
