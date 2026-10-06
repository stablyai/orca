import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'
import { literalPathspec } from './git-pathspec'
import { encodeGitPathspecs } from '../../../shared/git-pathspec-stdin'

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
    await gitExecFileAsync(
      ['add', '--', literalPathspec(filePath, options)],
      gitOptionsForWorktree(worktreePath, options)
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
    // Reset treats an unborn HEAD as an empty tree, preserving the working file.
    await gitExecFileAsync(['reset', '--quiet', '--', literalPathspec(filePath, options)], {
      ...gitOptionsForWorktree(worktreePath, options)
    })
  } finally {
    invalidateGitReadCaches()
  }
}

/**
 * Stage selected files through stdin to avoid argv limits and repeated index writes.
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
    await gitExecFileAsync(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      ...gitOptionsForWorktree(worktreePath, options),
      stdin: encodeGitPathspecs(filePaths.map((filePath) => literalPathspec(filePath, options)))
    })
  } finally {
    invalidateGitReadCaches()
  }
}

/**
 * Unstage selected files through stdin to avoid argv limits and repeated index writes.
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
    await gitExecFileAsync(['reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      ...gitOptionsForWorktree(worktreePath, options),
      stdin: encodeGitPathspecs(filePaths.map((filePath) => literalPathspec(filePath, options)))
    })
  } finally {
    invalidateGitReadCaches()
  }
}
