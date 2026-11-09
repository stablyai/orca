import { lstat } from 'node:fs/promises'
import { isUnsupportedWorktreeAddLockReasonError } from '../../../../shared/git/worktrees/git-worktree-command-capabilities'
import { resolveWorktreeHostPath } from '../../../../shared/git/metadata/git-metadata-path'
import { windowsLongPathGitArgs } from '../../../../shared/windows-long-path-git-args'
import { toHostFilesystemPath } from '../../../filesystem/host-tree-removal'
import { withLocalGitCapabilityCacheForExecution } from '../../command-runner/git-capability-state'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  getErrorCode,
  gitExecOptions,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'
import {
  runStandalonePreparation,
  type WorktreePreparationOperation
} from './worktree-preparation-operation'
import { discardPreparedWorktree } from './worktree-preparation-discard'
import {
  lockWorktreePreparation,
  verifyWorktreePreparationLock,
  WorktreePreparationLockOwnershipError
} from './worktree-preparation-lock'
import { invalidateWslLinkedWorktreeGitRouting } from '../../command-runner/wsl-linked-worktree-git-routing'

async function isAbsent(worktreePath: string, options: GitWorktreeExecOptions): Promise<boolean> {
  const hostPath = resolveWorktreeHostPath(worktreePath, options)
  if (!hostPath) {
    throw new Error('The prepared worktree path is empty')
  }
  try {
    await lstat(toHostFilesystemPath(hostPath))
    return false
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return true
    }
    throw error
  }
}

export async function addLockedWorktreePreparation(
  repoPath: string,
  worktreePath: string,
  baseRef: string,
  lockReason: string,
  options: GitWorktreeExecOptions,
  operation?: WorktreePreparationOperation
): Promise<string> {
  if (!operation) {
    return runStandalonePreparation(options, (owned) =>
      owned.withMaintenancePaused(() =>
        addLockedWorktreePreparation(
          repoPath,
          worktreePath,
          baseRef,
          lockReason,
          owned.executionOptions(),
          owned
        )
      )
    )
  }
  const add = async (lockArgs: string[]): Promise<void> => {
    options.signal?.throwIfAborted()
    try {
      await gitExecFileAsync(
        [
          ...windowsLongPathGitArgs(repoPath),
          'worktree',
          'add',
          '--detach',
          '--no-checkout',
          ...lockArgs,
          worktreePath,
          baseRef
        ],
        gitExecOptions(repoPath, options)
      )
    } finally {
      invalidateWslLinkedWorktreeGitRouting(worktreePath)
    }
  }
  return withLocalGitCapabilityCacheForExecution(
    { cwd: repoPath, wslDistro: options.wslDistro, signal: options.signal },
    async (capabilities) => {
      options.signal?.throwIfAborted()
      const initiallyAbsent = await isAbsent(worktreePath, options)
      options.signal?.throwIfAborted()
      return capabilities.runWithFallback(
        'worktree-add-lock-reason',
        async () => {
          let added = false
          try {
            await add(['--lock', '--reason', lockReason])
            added = true
            const lockPath = await verifyWorktreePreparationLock(worktreePath, lockReason, options)
            operation.setDiscard((cleanupOptions) =>
              discardPreparedWorktree(repoPath, worktreePath, cleanupOptions, lockReason)
            )
            return lockPath
          } catch (error) {
            operation.setDiscard()
            // A canceled add can leave its marker; a pre-existing checkout is never ours to remove.
            if (
              (added || initiallyAbsent) &&
              !isUnsupportedWorktreeAddLockReasonError(error) &&
              !(error instanceof WorktreePreparationLockOwnershipError)
            ) {
              operation.setDiscard((cleanupOptions) =>
                discardPreparedWorktree(repoPath, worktreePath, cleanupOptions, lockReason)
              )
            }
            throw error
          }
        },
        async () => {
          let added = false
          try {
            await add([])
            added = true
            const lockPath = await lockWorktreePreparation(
              worktreePath,
              lockReason,
              options,
              operation
            )
            operation.setDiscard((cleanupOptions) =>
              discardPreparedWorktree(repoPath, worktreePath, cleanupOptions, lockReason)
            )
            return lockPath
          } catch (error) {
            operation.setDiscard()
            if (
              added &&
              initiallyAbsent &&
              !(error instanceof WorktreePreparationLockOwnershipError)
            ) {
              // Single force reclaims our unlocked add while preserving any competing lock.
              operation.setDiscard((cleanupOptions) =>
                discardPreparedWorktree(repoPath, worktreePath, {
                  ...cleanupOptions,
                  timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
                })
              )
            }
            throw error
          }
        },
        isUnsupportedWorktreeAddLockReasonError
      )
    }
  )
}
