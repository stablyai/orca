import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { runWithGitWorktreeOperationLock } from '../../../shared/git-worktree-operation-lock'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'
import { bulkPathspecCommands, literalPathspec } from './git-pathspec'
import { runWithGitIndexLockRetry } from '../../../shared/git-index-lock-retry'

/**
 * Stage a file.
 */
export async function stageFile(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  try {
    await runWithGitWorktreeOperationLock(worktreePath, options.signal, () =>
      runWithGitIndexLockRetry(
        () =>
          gitExecFileAsync(
            ['add', '--', literalPathspec(filePath, options)],
            gitOptionsForWorktree(worktreePath, options)
          ),
        options.signal
      )
    )
  } finally {
    invalidateGitReadCaches()
  }
}

/**
 * Unstage a file.
 */
export async function unstageFile(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  try {
    await runWithGitWorktreeOperationLock(worktreePath, options.signal, () =>
      runWithGitIndexLockRetry(
        () =>
          gitExecFileAsync(['restore', '--staged', '--', literalPathspec(filePath, options)], {
            ...gitOptionsForWorktree(worktreePath, options)
          }),
        options.signal
      )
    )
  } finally {
    invalidateGitReadCaches()
  }
}

/**
 * Bulk stage files in batches to avoid E2BIG.
 */
export async function bulkStageFiles(
  worktreePath: string,
  filePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  if (filePaths.length === 0) {
    return
  }
  try {
    await runWithGitWorktreeOperationLock(worktreePath, options.signal, async () => {
      for (const args of bulkPathspecCommands(['add', '--'], filePaths, worktreePath, options)) {
        await runWithGitIndexLockRetry(
          () => gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options)),
          options.signal
        )
      }
    })
  } finally {
    invalidateGitReadCaches()
  }
}

/**
 * Bulk unstage files in batches to avoid E2BIG.
 */
export async function bulkUnstageFiles(
  worktreePath: string,
  filePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  if (filePaths.length === 0) {
    return
  }
  try {
    await runWithGitWorktreeOperationLock(worktreePath, options.signal, async () => {
      const commands = bulkPathspecCommands(
        ['restore', '--staged', '--'],
        filePaths,
        worktreePath,
        options
      )
      for (const args of commands) {
        await runWithGitIndexLockRetry(
          () => gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options)),
          options.signal
        )
      }
    })
  } finally {
    invalidateGitReadCaches()
  }
}
