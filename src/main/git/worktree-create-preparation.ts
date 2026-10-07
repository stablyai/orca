import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'
import type { AddWorktreeOptions, AddWorktreeResult, GitWorktreeExecOptions } from './worktree'
import { gitExecOptions } from './worktree-operation-options'
import {
  configurePushAutoSetupRemote,
  notifyPreparedWorktreeMutation,
  persistWorktreeCreationBase,
  resolveWorktreeAddBaseContext,
  resolveWorktreeAddTimeoutMs,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
} from './worktree'
import {
  gitCleanupOptions,
  performDiscardPreparedWorktree,
  removeFailedFinalization
} from './worktree-preparation-discard'
import { hasWorktreeBaseCommitRef } from './worktree-base-ref-probe'
import { withRepoRefMaintenancePaused } from './local-repo-ref-maintenance'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'
import {
  unlockWorktreePreparation,
  unlockWorktreePreparationAtPath,
  verifyWorktreePreparationLock,
  verifyWorktreePreparationLockAtPath,
  WorktreePreparationLockOwnershipError
} from './worktree-preparation-lock'
import { addLockedWorktreePreparation } from './worktree-preparation-add'

export async function prepareWorktreeCreateCheckout(
  repoPath: string,
  worktreePath: string,
  baseBranch: string,
  lockReason: string,
  options: GitWorktreeExecOptions = {},
  beforeMaterialization?: Promise<void>
): Promise<void> {
  // Observe early rejection while registration runs; awaiting still reports the original error.
  void beforeMaterialization?.catch(() => {})
  try {
    await withRepoRefMaintenancePaused('worktree-prepare', () =>
      runWithGitReadCacheInvalidation(async () => {
        const effectiveBase = await resolveWorktreeAddBaseRef(baseBranch, (qualifiedRef) =>
          hasWorktreeBaseCommitRef(repoPath, qualifiedRef, options)
        )
        let lockPath: string | undefined
        try {
          lockPath = await addLockedWorktreePreparation(
            repoPath,
            worktreePath,
            effectiveBase,
            lockReason,
            {
              ...options,
              timeout: resolveWorktreeAddTimeoutMs()
            }
          )
          await verifyWorktreePreparationLockAtPath(lockPath, lockReason, options.signal)
          let materializationBase = effectiveBase
          if (beforeMaterialization) {
            await waitForPromiseWithSignal(beforeMaterialization, options.signal)
            await verifyWorktreePreparationLockAtPath(lockPath, lockReason, options.signal)
            const { stdout } = await gitExecFileAsync(
              ['rev-parse', '--verify', `${effectiveBase}^{commit}`],
              gitExecOptions(repoPath, options)
            )
            materializationBase = stdout.trim()
            await verifyWorktreePreparationLockAtPath(lockPath, lockReason, options.signal)
          }
          // Why: reset materializes files without running user post-checkout hooks before submit.
          await gitExecFileAsync(
            [...windowsLongPathGitArgs(worktreePath), 'reset', '--hard', materializationBase],
            { ...gitExecOptions(worktreePath, options), timeout: resolveWorktreeAddTimeoutMs() }
          )
          await verifyWorktreePreparationLockAtPath(lockPath, lockReason, options.signal)
        } catch (error) {
          if (lockPath !== undefined && !(error instanceof WorktreePreparationLockOwnershipError)) {
            await performDiscardPreparedWorktree(repoPath, worktreePath, options, lockReason).catch(
              () => {}
            )
          }
          throw error
        }
      })
    )
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}

export async function discardPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {},
  expectedLockReason: string
): Promise<void> {
  try {
    await runWithGitReadCacheInvalidation(() =>
      performDiscardPreparedWorktree(repoPath, worktreePath, options, expectedLockReason)
    )
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}

export async function unlockPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {},
  expectedLockReason: string
): Promise<void> {
  const cleanupGitOptions = {
    ...gitCleanupOptions(repoPath, options),
    timeout: options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  }
  try {
    await runWithGitReadCacheInvalidation(async () => {
      await unlockWorktreePreparation(worktreePath, expectedLockReason, cleanupGitOptions)
    })
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}

export type FinalizedPreparedWorktree = AddWorktreeResult & {
  /** The prepared checkout was not already at the requested commit, so it was reset onto it. */
  preparedHeadReset: boolean
}

export async function finalizePreparedWorktree(
  repoPath: string,
  preparedPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
  refreshLocalBaseRef = false,
  options: AddWorktreeOptions = {},
  expectedLockReason: string
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
          [...windowsLongPathGitArgs(preparedPath), 'reset', '--hard', targetHead],
          gitExecOptions(preparedPath, finalizeGitOptions)
        )
      }

      let moved = false
      try {
        try {
          await verifyOwnership()
          // Why: `-f -f` moves the locked preparation while preserving its lock reason (Git >=2.25).
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
            gitExecOptions(repoPath, finalizeGitOptions)
          )
          moved = true
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
        await configurePushAutoSetupRemote(worktreePath, finalizeGitOptions)
        await unlockWorktreePreparationAtPath(
          lockPath,
          expectedLockReason,
          finalizeGitOptions.signal
        )
      } catch (error) {
        if (!(error instanceof WorktreePreparationLockOwnershipError)) {
          await removeFailedFinalization(
            repoPath,
            moved ? worktreePath : preparedPath,
            branch,
            moved,
            finalizeGitOptions,
            expectedLockReason
          )
        }
        await baseContext.pendingLocalBaseRefRefresh
        throw error
      }
      // Why: the refresh overlapped the finalize above; it has no bearing on the checkout's content.
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
