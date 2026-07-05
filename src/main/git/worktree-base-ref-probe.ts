import { gitExecFileAsync } from './runner'

type GitExecOptions = {
  wslDistro?: string
}

export async function hasWorktreeBaseCommitRef(
  repoPath: string,
  qualifiedRef: string,
  options: GitExecOptions = {}
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', '--quiet', `${qualifiedRef}^{commit}`],
      {
        cwd: repoPath,
        ...options
      }
    )
    return stdout.trim().length > 0
  } catch {
    return false
  }
}
