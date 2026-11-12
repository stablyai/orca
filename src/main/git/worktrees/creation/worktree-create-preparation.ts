import { runStandalonePreparation } from './worktree-preparation-standalone'
import { performPreparedWorktreeFinalization } from './worktree-preparation-finalization-work'
import { windowsLongPathGitArgs } from '../../../../shared/windows-long-path-git-args'
import { checkoutWorkersGitArgs } from './checkout-workers-git-args'
import { resolveWorktreeAddBaseRef } from '../../../../shared/worktree/base-ref'
import type {
  AddWorktreeOptions,
  AddWorktreeResult,
  GitWorktreeExecOptions
} from '../worktree-operation-options'
import {
  gitExecOptions,
  resolveWorktreeAddTimeoutMs,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
} from '../worktree-operation-options'
import { bumpWorktreeScanGeneration as notifyPreparedWorktreeMutation } from '../catalog/worktree-scan-cache'
import {
  gitCleanupOptions,
  removeFailedFinalization,
  reconcilePreparationLocation,
  discardPreparedWorktree as discardOwnedPreparation
} from './worktree-preparation-discard'
import { hasWorktreeBaseCommitRef } from './worktree-base-ref-probe'
import { WorktreePreparationOperation } from './worktree-preparation-operation'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { runWithGitReadCacheInvalidation } from '../../source-control/git-read-cache-invalidation'
import {
  unlockWorktreePreparation,
  verifyWorktreePreparationLockAtPath
} from './worktree-preparation-lock'
import { addLockedWorktreePreparation } from './worktree-preparation-add'
import {
  cloneMainCheckoutIntoWorktree,
  resolveCopyOnWriteCheckout
} from './worktree-copy-on-write-checkout'

export async function prepareWorktreeCreateCheckout(
  repoPath: string,
  worktreePath: string,
  baseBranch: string,
  lockReason: string,
  options: GitWorktreeExecOptions = {},
  beforeMaterialization?: Promise<void>,
  operation?: WorktreePreparationOperation
): Promise<void> {
  if (!operation) {
    return runStandalonePreparation(options, (owned) =>
      prepareWorktreeCreateCheckout(
        repoPath,
        worktreePath,
        baseBranch,
        lockReason,
        options,
        beforeMaterialization,
        owned
      )
    )
  }
  options = operation.executionOptions()
  // Observe early rejection while registration runs; awaiting still reports the original error.
  void beforeMaterialization?.catch(() => {})
  try {
    await operation.withMaintenancePaused(() =>
      runWithGitReadCacheInvalidation(async () => {
        // Overlap preparation; neither rejects.
        const checkoutWorkersArgs = checkoutWorkersGitArgs(repoPath, options)
        const copyOnWrite = resolveCopyOnWriteCheckout(repoPath, worktreePath, options)
        const effectiveBase = await resolveWorktreeAddBaseRef(baseBranch, (qualifiedRef) =>
          hasWorktreeBaseCommitRef(repoPath, qualifiedRef, options)
        )
        options.signal?.throwIfAborted()
        const lockPath = await addLockedWorktreePreparation(
          repoPath,
          worktreePath,
          effectiveBase,
          lockReason,
          {
            ...options,
            timeout: resolveWorktreeAddTimeoutMs()
          },
          operation
        )
        await verifyWorktreePreparationLockAtPath(lockPath, lockReason, options.signal)
        let materializationBase = effectiveBase
        if (beforeMaterialization) {
          await operation.waitForMaterialization(beforeMaterialization)
          await verifyWorktreePreparationLockAtPath(lockPath, lockReason, options.signal)
          const { stdout } = await gitExecFileAsync(
            ['rev-parse', '--verify', `${effectiveBase}^{commit}`],
            gitExecOptions(repoPath, options)
          )
          materializationBase = stdout.trim()
          await verifyWorktreePreparationLockAtPath(lockPath, lockReason, options.signal)
        }
        const [workers, cloneMethod] = await Promise.all([checkoutWorkersArgs, copyOnWrite])
        options.signal?.throwIfAborted()
        if (cloneMethod) {
          await cloneMainCheckoutIntoWorktree(
            cloneMethod,
            repoPath,
            worktreePath,
            materializationBase,
            options
          )
          await verifyWorktreePreparationLockAtPath(lockPath, lockReason, options.signal)
        }
        // Materialize with reset to defer user post-checkout hooks until submission.
        await gitExecFileAsync(
          [
            ...workers,
            ...windowsLongPathGitArgs(worktreePath),
            'reset',
            '--hard',
            materializationBase
          ],
          { ...gitExecOptions(worktreePath, options), timeout: resolveWorktreeAddTimeoutMs() }
        )
        await verifyWorktreePreparationLockAtPath(lockPath, lockReason, options.signal)
      })
    )
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}

export { discardPreparedWorktree } from './worktree-preparation-discard'

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
  preparedHeadReset: boolean
}

export class PreparedWorktreeFinalizationPendingError extends Error {
  constructor(readonly originalError: unknown) {
    super('The prepared checkout still has an unverified target writer.', { cause: originalError })
  }
}

export async function finalizePreparedWorktree(
  repoPath: string,
  preparedPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
  refreshLocalBaseRef = false,
  options: AddWorktreeOptions = {},
  expectedLockReason: string,
  operation?: WorktreePreparationOperation
): Promise<FinalizedPreparedWorktree> {
  const owner = operation ?? new WorktreePreparationOperation(options)
  let pendingTarget = false
  const captured: { lockPath?: string; targetWriter: boolean } = { targetWriter: false }
  if (!operation) {
    owner.setDiscard((cleanupOptions) =>
      discardOwnedPreparation(repoPath, preparedPath, cleanupOptions, expectedLockReason)
    )
  }
  try {
    const result = await owner.supervise(options, (ownedOptions) =>
      performPreparedWorktreeFinalization(
        repoPath,
        preparedPath,
        worktreePath,
        branch,
        baseBranch,
        refreshLocalBaseRef,
        { ...options, ...ownedOptions },
        expectedLockReason,
        owner,
        captured
      )
    )
    await owner.physicalSettlement()
    owner.finishFinalization('disposed')
    return result
  } catch (error) {
    const settled = await owner.waitForPhysicalSettlement()
    if (captured.lockPath) {
      owner.setDiscard(async (cleanupOptions) => {
        if (!captured.lockPath) {
          return 'revoked'
        }
        const location = await reconcilePreparationLocation(
          captured.lockPath,
          preparedPath,
          worktreePath,
          expectedLockReason,
          cleanupOptions
        )
        if (location === 'hidden') {
          return discardOwnedPreparation(
            repoPath,
            preparedPath,
            cleanupOptions,
            expectedLockReason,
            captured.lockPath
          )
        }
        return location === 'target' || location === 'unknown' ? 'revoked' : location
      })
    }
    if (settled && captured.lockPath) {
      const location = await reconcilePreparationLocation(
        captured.lockPath,
        preparedPath,
        worktreePath,
        expectedLockReason,
        options
      )
      if (location === 'target') {
        let eligible = true
        const rollback = owner.supervise(
          {
            ...options,
            signal: undefined,
            canStart: () => eligible && options.canStart?.() !== false
          },
          (rollbackOptions) =>
            removeFailedFinalization(
              repoPath,
              worktreePath,
              branch,
              true,
              rollbackOptions,
              expectedLockReason,
              captured.lockPath
            ),
          true
        )
        void rollback.catch(() => {})
        pendingTarget = !(await owner.waitForPhysicalSettlement(() => {
          eligible = false
        }))
        eligible = false
        if (!pendingTarget && (await rollback.catch(() => false))) {
          owner.finishFinalization('disposed')
        }
      }
    } else {
      pendingTarget = captured.targetWriter
    }
    owner.finishFinalization(!settled || pendingTarget ? 'pending' : 'failed')
    if (!operation) {
      await owner.discard()
    }
    if (pendingTarget && operation) {
      throw new PreparedWorktreeFinalizationPendingError(error)
    }
    throw error
  } finally {
    owner.finishFinalization()
  }
}
