import type { GitBlameResult } from '../shared/git-blame'
import { buildGitBlameArgv, parseBlamePorcelain } from '../shared/git-blame'
import type { GitExec } from './git-handler-ops'

export async function blameFile(
  git: GitExec,
  worktreePath: string,
  filePath: string,
  revision?: string
): Promise<GitBlameResult> {
  try {
    const { stdout } = await git(buildGitBlameArgv(filePath, revision), worktreePath)
    return { status: 'ready', lines: parseBlamePorcelain(stdout) }
  } catch {
    return { status: 'unavailable', lines: [] }
  }
}
