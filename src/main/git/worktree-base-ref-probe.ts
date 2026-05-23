import { gitExecFileAsync } from './runner'

export async function hasWorktreeBaseCommitRef(
  repoPath: string,
  qualifiedRef: string
): Promise<boolean> {
  try {
    await gitExecFileAsync(['rev-parse', '--verify', '--quiet', `${qualifiedRef}^{commit}`], {
      cwd: repoPath
    })
    return true
  } catch {
    return false
  }
}
