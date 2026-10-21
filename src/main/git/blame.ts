import type { GitBlameContentsSource, GitBlameResult } from '../../shared/git-blame'
import {
  buildGitBlameArgv,
  buildGitShowIndexArgv,
  GIT_BLAME_INDEX_CONTENTS,
  parseBlamePorcelain
} from '../../shared/git-blame'
import { gitReadOptionsForWorktree, type GitRuntimeOptions } from './git-runtime-options'
import { gitExecFileAsync } from './runner'

const BLAME_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const BLAME_TIMEOUT_MS = 15_000

export async function getFileBlame(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {},
  revision?: string,
  contentsSource?: GitBlameContentsSource
): Promise<GitBlameResult> {
  try {
    const readOptions = gitReadOptionsForWorktree(worktreePath, {
      ...options,
      admissionTier: options.admissionTier ?? 'interactive'
    })
    const execOptions = {
      ...readOptions,
      maxBuffer: BLAME_MAX_BUFFER_BYTES,
      timeout: BLAME_TIMEOUT_MS
    }
    let stdin: string | undefined
    if (contentsSource === GIT_BLAME_INDEX_CONTENTS) {
      const shown = await gitExecFileAsync(buildGitShowIndexArgv(filePath), execOptions)
      stdin = shown.stdout
    }
    const { stdout } = await gitExecFileAsync(
      buildGitBlameArgv(filePath, revision, contentsSource),
      stdin === undefined ? execOptions : { ...execOptions, stdin }
    )
    return { status: 'ready', lines: parseBlamePorcelain(stdout) }
  } catch {
    return { status: 'unavailable', lines: [] }
  }
}
