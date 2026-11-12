import { windowsLongPathGitArgs } from '../../../../shared/windows-long-path-git-args'
import { checkoutWorkersGitArgs } from './checkout-workers-git-args'
import type { AddWorktreeOptions } from '../worktree-operation-options'
import { gitExecOptions, resolveWorktreeAddTimeoutMs } from '../worktree-operation-options'
import {
  configurePushAutoSetupRemote,
  persistWorktreeCreationBase,
  resolveWorktreeAddBaseContext,
  trackSameNameRemoteBase
} from './worktree-add'
import { bumpWorktreeScanGeneration as notifyPreparedWorktreeMutation } from '../catalog/worktree-scan-cache'
import type { WorktreePreparationOperation } from './worktree-preparation-operation'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { runWithGitReadCacheInvalidation } from '../../source-control/git-read-cache-invalidation'
import { invalidateWslLinkedWorktreeGitRouting } from '../../command-runner/host-routing/wsl-linked-worktree-git-routing'
import {
  unlockWorktreePreparationAtPath,
  verifyWorktreePreparationLock,
  verifyWorktreePreparationLockAtPath
} from './worktree-preparation-lock'
import type { FinalizedPreparedWorktree } from './worktree-create-preparation'

export async function performPreparedWorktreeFinalization(
  repoPath: string,
  preparedPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
  refreshLocalBaseRef = false,
  options: AddWorktreeOptions = {},
  expectedLockReason: string,
  operation: WorktreePreparationOperation,
  captured: { lockPath?: string; targetWriter: boolean }
): Promise<FinalizedPreparedWorktree> {
  const finalizeGitOptions: AddWorktreeOptions = {
    ...options,
    timeout: options.timeout ?? resolveWorktreeAddTimeoutMs()
  }
  try {
    return await runWithGitReadCacheInvalidation(async () => {
      const lockPath = await verifyWorktreePreparationLock(
        preparedPath,
        expectedLockReason,
        finalizeGitOptions
      )
      captured.lockPath = lockPath
      const verifyOwnership = (): Promise<void> =>
        verifyWorktreePreparationLockAtPath(lockPath, expectedLockReason, finalizeGitOptions.signal)
      const [targetResult, preparedResult] = await Promise.allSettled([
        (async () => {
          const baseContext = await resolveWorktreeAddBaseContext(
            repoPath,
            baseBranch,
            refreshLocalBaseRef,
            finalizeGitOptions,
            branch
          )
          if (baseContext.pendingLocalBaseRefRefresh) {
            operation.trackWriter(baseContext.pendingLocalBaseRefRefresh)
          }
          const targetHead =
            baseContext.effectiveBaseOid ??
            (
              await gitExecFileAsync(
                ['rev-parse', '--verify', `${baseContext.effectiveBase}^{commit}`],
                gitExecOptions(repoPath, finalizeGitOptions)
              )
            ).stdout.trim()
          return { baseContext, targetHead }
        })(),
        gitExecFileAsync(
          ['rev-parse', '--verify', 'HEAD'],
          gitExecOptions(preparedPath, finalizeGitOptions)
        )
      ])
      // Settle both reads before failure cleanup can remove the prepared checkout.
      if (targetResult.status === 'rejected') {
        throw targetResult.reason
      }
      const { baseContext, targetHead } = targetResult.value
      if (preparedResult.status === 'rejected') {
        await baseContext.pendingLocalBaseRefRefresh
        throw preparedResult.reason
      }
      const preparedHeadReset = preparedResult.value.stdout.trim() !== targetHead
      if (preparedHeadReset) {
        await verifyOwnership()
        await gitExecFileAsync(
          [
            ...(await checkoutWorkersGitArgs(preparedPath, finalizeGitOptions)),
            ...windowsLongPathGitArgs(preparedPath),
            'reset',
            '--hard',
            targetHead
          ],
          gitExecOptions(preparedPath, finalizeGitOptions)
        )
      }

      try {
        try {
          await verifyOwnership()
          // Git >= 2.25 needs two force flags to move a locked preparation without losing its lock reason.
          await gitExecFileAsync(
            [
              ...windowsLongPathGitArgs(repoPath),
              'worktree',
              'move',
              '-f',
              '-f',
              preparedPath,
              worktreePath
            ],
            {
              ...gitExecOptions(repoPath, finalizeGitOptions),
              observeChildTermination: (terminated, writes) => {
                if (writes) {
                  captured.targetWriter = true
                }
                finalizeGitOptions.observeChildTermination?.(terminated, writes)
              }
            }
          )
        } finally {
          // The move rewrites both `.git` markers, and a failure can have rewritten one.
          invalidateWslLinkedWorktreeGitRouting(preparedPath)
          invalidateWslLinkedWorktreeGitRouting(worktreePath)
        }
        await verifyOwnership()
        await gitExecFileAsync(
          [
            ...windowsLongPathGitArgs(worktreePath),
            'checkout',
            '--no-track',
            '-b',
            branch,
            targetHead
          ],
          gitExecOptions(worktreePath, finalizeGitOptions)
        )
        await verifyOwnership()
        await persistWorktreeCreationBase(
          worktreePath,
          branch,
          baseContext.effectiveBase,
          finalizeGitOptions
        )
        await trackSameNameRemoteBase(
          worktreePath,
          branch,
          baseBranch,
          baseContext.effectiveBase,
          finalizeGitOptions
        )
        await configurePushAutoSetupRemote(worktreePath, finalizeGitOptions)
        await unlockWorktreePreparationAtPath(
          lockPath,
          expectedLockReason,
          finalizeGitOptions.signal,
          operation
        )
      } catch (error) {
        await baseContext.pendingLocalBaseRefRefresh
        throw error
      }
      // Advisory refresh may settle after finalization; it does not determine checkout contents.
      const localBaseRefRefresh = await baseContext.pendingLocalBaseRefRefresh
      return {
        preparedHeadReset,
        ...(localBaseRefRefresh ? { localBaseRefRefresh } : {}),
        ...(baseContext.localBaseRefUpdateSuggestion
          ? { localBaseRefUpdateSuggestion: baseContext.localBaseRefUpdateSuggestion }
          : {})
      }
    })
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}
