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
    await gitExecFileAsync(['rev-parse', '--verify', '--quiet', `${qualifiedRef}^{commit}`], {
      cwd: repoPath,
      ...options
    })
    return true
  } catch {
    return false
  }
}
