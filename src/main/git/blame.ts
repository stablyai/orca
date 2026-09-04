import type { GitBlameResult } from '../../shared/git-blame'
import { buildGitBlameArgv, parseBlamePorcelain } from '../../shared/git-blame'
import { gitReadOptionsForWorktree, type GitRuntimeOptions } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

const BLAME_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const BLAME_TIMEOUT_MS = 15_000

export async function getFileBlame(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {},
  revision?: string
): Promise<GitBlameResult> {
  try {
    const { stdout } = await gitExecFileAsync(buildGitBlameArgv(filePath, revision), {
      ...gitReadOptionsForWorktree(worktreePath, {
        ...options,
        admissionTier: options.admissionTier ?? 'interactive'
      }),
      maxBuffer: BLAME_MAX_BUFFER_BYTES,
      timeout: BLAME_TIMEOUT_MS
    })
    return { status: 'ready', lines: parseBlamePorcelain(stdout) }
  } catch {
    return { status: 'unavailable', lines: [] }
  }
}
