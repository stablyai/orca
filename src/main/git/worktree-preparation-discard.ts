import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { resolveWorktreeHostPath } from '../../shared/git-metadata-path'
import { findLinkedWorktreeGitDirectory } from '../../shared/git-worktree-admin'
import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { toHostFilesystemPath } from '../host-tree-removal'
import { gitExecFileAsync } from './runner'
import {
  getErrorCode,
  gitExecOptions,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
  type GitExecOptionsForWorktree,
  type GitWorktreeExecOptions
} from './worktree-operation-options'
import {
  verifyWorktreePreparationLock,
  verifyWorktreePreparationLockAtPath,
  WorktreePreparationLockOwnershipError
} from './worktree-preparation-lock'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'

export function gitCleanupOptions(
  cwd: string,
  options: GitWorktreeExecOptions
): GitExecOptionsForWorktree {
  // Why: cancellation must not strand a partially moved worktree; cleanup is bounded separately.
  return gitExecOptions(cwd, { ...options, signal: undefined })
}

async function verifyDiscardPreparationOwner(
  repoPath: string,
  worktreePath: string,
  expectedLockReason: string,
  options: GitExecOptionsForWorktree
): Promise<void> {
  try {
    await verifyWorktreePreparationLock(worktreePath, expectedLockReason, options)
  } catch (error) {
    if (error instanceof WorktreePreparationLockOwnershipError) {
      throw error
    }
    const hostPath = resolveWorktreeHostPath(worktreePath, options)
    const hostRepo = resolveWorktreeHostPath(repoPath, options)
    if (!hostPath || !hostRepo) {
      throw error
    }
    const signal = AbortSignal.timeout(options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS)
    const absent = await waitForPromiseWithSignal(
      lstat(toHostFilesystemPath(hostPath)),
      signal
    ).then(
      () => false,
      (failure: unknown) => {
        if (getErrorCode(failure) === 'ENOENT') {
          return true
        }
        throw failure
      }
    )
    if (!absent) {
      throw error
    }
    const gitDir = await findLinkedWorktreeGitDirectory(hostRepo, hostPath, { ...options, signal })
    if (!gitDir) {
      throw new WorktreePreparationLockOwnershipError(error)
    }
    const lockPath = toHostFilesystemPath(join(gitDir, 'locked'))
    const marker = await waitForPromiseWithSignal(lstat(lockPath), signal).catch(
      (failure: unknown) => {
        throw new WorktreePreparationLockOwnershipError(failure)
      }
    )
    if (!marker.isFile()) {
      throw new WorktreePreparationLockOwnershipError()
    }
    await waitForPromiseWithSignal(
      verifyWorktreePreparationLockAtPath(lockPath, expectedLockReason, signal),
      signal
    )
  }
}

export async function performDiscardPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions,
  expectedLockReason?: string
): Promise<void> {
  const cleanupGitOptions = {
    ...gitCleanupOptions(repoPath, options),
    timeout: options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  }
  try {
    if (expectedLockReason !== undefined) {
      await verifyDiscardPreparationOwner(
        repoPath,
        worktreePath,
        expectedLockReason,
        cleanupGitOptions
      )
    }
    // Double force requires a freshly verified ownership marker.
    await gitExecFileAsync(
      [
        ...windowsLongPathGitArgs(repoPath),
        'worktree',
        'remove',
        '--force',
        ...(expectedLockReason === undefined ? [] : ['--force']),
        worktreePath
      ],
      cleanupGitOptions
    )
  } finally {
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
  }
}

export async function removeFailedFinalization(
  repoPath: string,
  cleanupPath: string,
  branch: string,
  moved: boolean,
  options: GitWorktreeExecOptions,
  expectedLockReason?: string
): Promise<void> {
  let branchAttached = false
  if (moved) {
    try {
      const { stdout } = await gitExecFileAsync(
        ['symbolic-ref', '--short', 'HEAD'],
        gitCleanupOptions(cleanupPath, options)
      )
      branchAttached = stdout.trim() === branch
    } catch {
      // Detached or no longer readable.
    }
  }
  const removed = await performDiscardPreparedWorktree(
    repoPath,
    cleanupPath,
    options,
    expectedLockReason
  ).then(
    () => true,
    () => false
  )
  if (!removed) {
    return
  }
  if (branchAttached) {
    await gitExecFileAsync(
      ['branch', '-D', '--', branch],
      gitCleanupOptions(repoPath, options)
    ).catch(() => {})
  }
}
