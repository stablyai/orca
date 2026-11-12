import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  getErrorCode,
  gitExecOptions,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'

/**
 * `git config --get`: the trimmed, lowercased value, or undefined when unset (exit 1). Any other
 * failure throws, so callers can fail closed instead of mistaking it for "unset".
 */
export async function readGitConfigValue(
  cwd: string,
  key: string,
  options: GitWorktreeExecOptions,
  typeArgs: string[] = []
): Promise<string | undefined> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['config', ...typeArgs, '--get', key],
      gitExecOptions(cwd, options)
    )
    return stdout.trim().toLowerCase()
  } catch (error) {
    if (getErrorCode(error) === '1') {
      return undefined
    }
    throw error
  }
}
