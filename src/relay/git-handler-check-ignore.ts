import type { GitExec } from './git-handler-ops'
import {
  encodeGitCheckIgnorePaths,
  GIT_CHECK_IGNORE_STDIN_ARGS,
  GIT_CHECK_IGNORE_TIMEOUT_MS,
  parseGitCheckIgnorePaths,
  splitGitCheckIgnorePathsByStdinBytes
} from '../shared/git-check-ignore-stdio'

export async function checkIgnoredPathsOp(
  git: GitExec,
  params: Record<string, unknown>
): Promise<string[]> {
  const worktreePath = params.worktreePath as string
  const paths = Array.isArray(params.paths)
    ? params.paths.filter((path): path is string => typeof path === 'string' && path.length > 0)
    : []
  const ignored: string[] = []
  for (const chunk of splitGitCheckIgnorePathsByStdinBytes(paths)) {
    try {
      const { stdout } = await git([...GIT_CHECK_IGNORE_STDIN_ARGS], worktreePath, {
        stdin: encodeGitCheckIgnorePaths(chunk),
        timeout: GIT_CHECK_IGNORE_TIMEOUT_MS
      })
      ignored.push(...parseGitCheckIgnorePaths(stdout))
    } catch (error) {
      const gitError = error as Error & { code?: number | string; stdout?: string }
      if (gitError.code !== 1) {
        throw error
      }
      ignored.push(...parseGitCheckIgnorePaths(gitError.stdout ?? ''))
    }
  }
  return ignored
}
