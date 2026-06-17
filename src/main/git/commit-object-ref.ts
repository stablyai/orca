import { gitExecFileAsync } from './runner'

type GitExec = (args: string[]) => Promise<unknown>

const FULL_GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40}$/i

export function isFullGitObjectId(value: string): boolean {
  return FULL_GIT_OBJECT_ID_PATTERN.test(value.trim())
}

export async function hasCommitObjectViaGitExec(gitExec: GitExec, ref: string): Promise<boolean> {
  const candidate = ref.trim()
  if (!isFullGitObjectId(candidate)) {
    return false
  }
  try {
    await gitExec(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
    return true
  } catch {
    return false
  }
}

export function hasLocalCommitObject(repoPath: string, ref: string): Promise<boolean> {
  return hasCommitObjectViaGitExec((args) => gitExecFileAsync(args, { cwd: repoPath }), ref)
}
