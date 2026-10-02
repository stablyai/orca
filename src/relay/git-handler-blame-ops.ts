import type { GitBlameContentsSource, GitBlameResult } from '../shared/git-blame'
import {
  buildGitBlameArgv,
  buildGitShowIndexArgv,
  GIT_BLAME_INDEX_CONTENTS,
  parseBlamePorcelain,
  parseGitBlameRevision
} from '../shared/git-blame'
import type { GitExec } from './git-handler-ops'
import { assertGitPathInsideWorktree } from './git-handler-utils'

export async function blameFile(
  git: GitExec,
  worktreePath: string,
  filePath: string,
  revision?: string,
  contentsSource?: GitBlameContentsSource
): Promise<GitBlameResult> {
  // Why: match git.diff — reject traversal before git sees the path.
  assertGitPathInsideWorktree(worktreePath, filePath)
  // Why: revision sits before --end-of-options, so a flag-like value would be
  // parsed as a git option. Reject anything that is not HEAD or a full oid.
  const blameRevision = parseGitBlameRevision(revision)
  try {
    let stdin: string | undefined
    if (contentsSource === GIT_BLAME_INDEX_CONTENTS) {
      const shown = await git(buildGitShowIndexArgv(filePath), worktreePath)
      stdin = shown.stdout
    }
    const { stdout } = await git(
      buildGitBlameArgv(filePath, blameRevision, contentsSource),
      worktreePath,
      stdin === undefined ? undefined : { stdin }
    )
    return { status: 'ready', lines: parseBlamePorcelain(stdout) }
  } catch {
    return { status: 'unavailable', lines: [] }
  }
}
