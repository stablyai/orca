import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  encodeGitCheckIgnorePaths,
  GIT_CHECK_IGNORE_STDIN_ARGS,
  GIT_CHECK_IGNORE_TIMEOUT_MS,
  parseGitCheckIgnorePaths,
  splitGitCheckIgnorePathsByStdinBytes
} from '../../../../shared/git/paths/git-check-ignore-stdio'
import { withoutPathsInsideSubmodules } from '../submodules/submodule-paths'

type GitExecError = Error & { stdout?: string; code?: number | string }

async function runCheckIgnoredPaths(
  worktreePath: string,
  relativePaths: string[],
  options: GitRuntimeOptions
): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync([...GIT_CHECK_IGNORE_STDIN_ARGS], {
      ...gitOptionsForWorktree(worktreePath, options),
      stdin: encodeGitCheckIgnorePaths(relativePaths),
      timeout: GIT_CHECK_IGNORE_TIMEOUT_MS
    })
    return parseGitCheckIgnorePaths(stdout)
  } catch (error) {
    const gitError = error as GitExecError
    if (gitError.code === 1) {
      return parseGitCheckIgnorePaths(gitError.stdout ?? '')
    }
    throw error
  }
}

async function runCheckIgnoredPathChunks(
  worktreePath: string,
  relativePaths: string[],
  options: GitRuntimeOptions
): Promise<string[]> {
  const ignored = new Set<string>()
  for (const chunk of splitGitCheckIgnorePathsByStdinBytes(relativePaths)) {
    for (const ignoredPath of await runCheckIgnoredPaths(worktreePath, chunk, options)) {
      ignored.add(ignoredPath)
    }
  }
  return Array.from(ignored)
}

export async function checkIgnoredPaths(
  worktreePath: string,
  relativePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  if (relativePaths.length === 0) {
    return []
  }
  try {
    return await runCheckIgnoredPathChunks(worktreePath, relativePaths, options)
  } catch (error) {
    // Git rejects the whole batch for one path inside a submodule; look those up only after a failure.
    const checkable = await withoutPathsInsideSubmodules(
      worktreePath,
      relativePaths,
      options
    ).catch(() => relativePaths)
    if (checkable.length === relativePaths.length) {
      throw error
    }
    return runCheckIgnoredPathChunks(worktreePath, checkable, options)
  }
}
