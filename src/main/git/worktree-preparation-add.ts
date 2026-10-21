import { lstat } from 'node:fs/promises'
import { isUnsupportedWorktreeAddLockReasonError } from '../../shared/git-worktree-command-capabilities'
import { resolveWorktreeHostPath } from '../../shared/git-metadata-path'
import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { toHostFilesystemPath } from '../host-tree-removal'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import { gitExecFileAsync } from './runner'
import {
  getErrorCode,
  gitExecOptions,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
  type GitWorktreeExecOptions
} from './worktree-operation-options'
import { performDiscardPreparedWorktree } from './worktree-preparation-discard'
import {
  lockWorktreePreparation,
  verifyWorktreePreparationLock,
  WorktreePreparationLockOwnershipError
} from './worktree-preparation-lock'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'

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

export function addLockedWorktreePreparation(
  repoPath: string,
  worktreePath: string,
  baseRef: string,
  lockReason: string,
  options: GitWorktreeExecOptions
): Promise<string> {
  const add = async (lockArgs: string[]): Promise<void> => {
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
      const initiallyAbsent = await isAbsent(worktreePath, options)
      return capabilities.runWithFallback(
        'worktree-add-lock-reason',
        async () => {
          let added = false
          try {
            await add(['--lock', '--reason', lockReason])
            added = true
            return await verifyWorktreePreparationLock(worktreePath, lockReason, options)
          } catch (error) {
            // A canceled add can leave its marker; a pre-existing checkout is never ours to remove.
            if (
              (added || initiallyAbsent) &&
              !isUnsupportedWorktreeAddLockReasonError(error) &&
              !(error instanceof WorktreePreparationLockOwnershipError)
            ) {
              await performDiscardPreparedWorktree(
                repoPath,
                worktreePath,
                options,
                lockReason
              ).catch(() => {})
            }
            throw error
          }
        },
        async () => {
          let added = false
          try {
            await add([])
            added = true
            return await lockWorktreePreparation(worktreePath, lockReason, options)
          } catch (error) {
            if (
              added &&
              initiallyAbsent &&
              !(error instanceof WorktreePreparationLockOwnershipError)
            ) {
              // Single force reclaims our unlocked add while preserving any competing lock.
              await performDiscardPreparedWorktree(repoPath, worktreePath, {
                ...options,
                signal: undefined,
                timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
              }).catch(() => {})
            }
            throw error
          }
        },
        isUnsupportedWorktreeAddLockReasonError
      )
    }
  )
}
