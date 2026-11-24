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

// Code units below U+0300 never change under NFC, so ASCII and Latin-1 paths skip normalize().
const MAY_CHANGE_UNDER_NFC = /[\u0300-\uffff]/

/** Listed paths keyed by the composed (NFC) path to ask Git about; null when no path would change. */
function composedQueriesOnDarwin(relativePaths: string[]): Map<string, string[]> | null {
  // Why: macOS Git precomposes argv and directory reads but not stdin, so a decomposed (NFD)
  // listed name never matches a composed .gitignore pattern.
  if (process.platform !== 'darwin' || !relativePaths.some((p) => MAY_CHANGE_UNDER_NFC.test(p))) {
    return null
  }
  const listedByQuery = new Map<string, string[]>()
  for (const listed of relativePaths) {
    const query = MAY_CHANGE_UNDER_NFC.test(listed) ? listed.normalize('NFC') : listed
    const group = listedByQuery.get(query)
    if (group) {
      group.push(listed)
    } else {
      listedByQuery.set(query, [listed])
    }
  }
  return listedByQuery
}

export async function checkIgnoredPaths(
  worktreePath: string,
  relativePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  if (relativePaths.length === 0) {
    return []
  }
  const listedByQuery = composedQueriesOnDarwin(relativePaths)
  if (!listedByQuery) {
    return checkPathsAsGiven(worktreePath, relativePaths, options)
  }
  const ignored = await checkPathsAsGiven(worktreePath, [...listedByQuery.keys()], options)
  // Answer with the names the caller listed, not the composed queries.
  return ignored.flatMap((query) => listedByQuery.get(query) ?? [query])
}

async function checkPathsAsGiven(
  worktreePath: string,
  relativePaths: string[],
  options: GitRuntimeOptions
): Promise<string[]> {
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
