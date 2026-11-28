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

/** Listed paths keyed by their composed (NFC) spelling; null when no listed path changes under NFC. */
function composedSpellingsOnDarwin(relativePaths: string[]): Map<string, string[]> | null {
  // Why: macOS Git precomposes argv and directory reads but not stdin, so a decomposed (NFD)
  // listed name never matches a composed .gitignore pattern. NFC also rewrites characters Git
  // leaves alone (CJK compatibility ideographs, U+212B), so both spellings are asked.
  if (process.platform !== 'darwin') {
    return null
  }
  let listedByComposed: Map<string, string[]> | null = null
  for (const listed of relativePaths) {
    if (!MAY_CHANGE_UNDER_NFC.test(listed)) {
      continue
    }
    const composed = listed.normalize('NFC')
    if (composed === listed) {
      continue
    }
    listedByComposed ??= new Map()
    const group = listedByComposed.get(composed)
    if (group) {
      group.push(listed)
    } else {
      listedByComposed.set(composed, [listed])
    }
  }
  return listedByComposed
}

export async function checkIgnoredPaths(
  worktreePath: string,
  relativePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  if (relativePaths.length === 0) {
    return []
  }
  const listedByComposed = composedSpellingsOnDarwin(relativePaths)
  if (!listedByComposed) {
    return checkPathsAsGiven(worktreePath, relativePaths, options)
  }
  const listed = new Set(relativePaths)
  const composedOnly = [...listedByComposed.keys()].filter((composed) => !listed.has(composed))
  const ignored = await checkPathsAsGiven(
    worktreePath,
    [...relativePaths, ...composedOnly],
    options
  )
  // A listed path is ignored when either of its spellings matches; answer with listed names only.
  const answer = new Set<string>()
  for (const query of ignored) {
    if (listed.has(query)) {
      answer.add(query)
    }
    for (const listedPath of listedByComposed.get(query) ?? []) {
      answer.add(listedPath)
    }
  }
  return [...answer]
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
