import type { GitBlameResult } from '../../../shared/git-blame-types'
import { buildGitBlameArgs } from '../../../shared/git-blame-args'
import { parseGitBlamePorcelain } from '../../../shared/git-blame-porcelain-parser'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { isMaxBufferOverflowError } from '../max-buffer-overflow'
import { gitExecFileAsync } from '../runner'

// Why: porcelain repeats every source line, so the cap must exceed the largest file worth blaming.
const MAX_GIT_BLAME_OUTPUT_BYTES = 32 * 1024 * 1024

// Untracked paths, unborn HEADs, and non-repo folders have no history to show.
const UNBLAMEABLE_STDERR_PATTERN = /no such path|not a git repository|no such ref|bad revision/i

export async function getFileBlame(
  worktreePath: string,
  args: { filePath: string; contents?: string },
  options: GitRuntimeOptions = {}
): Promise<GitBlameResult | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      buildGitBlameArgs(args.filePath, args.contents !== undefined),
      {
        ...gitReadOptionsForWorktree(worktreePath, options),
        maxBuffer: MAX_GIT_BLAME_OUTPUT_BYTES,
        ...(args.contents === undefined ? {} : { stdin: args.contents })
      }
    )
    return parseGitBlamePorcelain(stdout)
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return null
    }
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error ? error.stderr : ''
    const message = error instanceof Error ? error.message : ''
    if (
      UNBLAMEABLE_STDERR_PATTERN.test(`${typeof stderr === 'string' ? stderr : ''}\n${message}`)
    ) {
      return null
    }
    throw error
  }
}
