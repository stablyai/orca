import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { gitExecFileAsync } from './runner'
import {
  gitExecOptions,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
  type GitExecOptionsForWorktree,
  type GitWorktreeExecOptions
} from './worktree-operation-options'
import { verifyWorktreePreparationLock } from './worktree-preparation-lock'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'

export function gitCleanupOptions(
  cwd: string,
  options: GitWorktreeExecOptions
): GitExecOptionsForWorktree {
  // Why: cancellation must not strand a partially moved worktree; cleanup is bounded separately.
  return gitExecOptions(cwd, { ...options, signal: undefined })
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
      await verifyWorktreePreparationLock(worktreePath, expectedLockReason, cleanupGitOptions)
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
