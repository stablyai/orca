import { deriveGitRemoteIdentity, type GitRemoteIdentity } from '../shared/git-remote-identity'
import { gitExecFileAsync } from './git/runner'
import { getSshGitProvider } from './providers/ssh-git-dispatch'

const GIT_REMOTE_IDENTITY_TIMEOUT_MS = 5000

export async function detectGitRemoteIdentity(
  repoPath: string,
  connectionId?: string | null
): Promise<GitRemoteIdentity | null> {
  try {
    const result = connectionId
      ? await getSshGitProvider(connectionId)?.exec(['remote', '-v'], repoPath, {
          timeoutMs: GIT_REMOTE_IDENTITY_TIMEOUT_MS
        })
      : await gitExecFileAsync(['remote', '-v'], {
          cwd: repoPath,
          timeout: GIT_REMOTE_IDENTITY_TIMEOUT_MS
        })
    return result ? deriveGitRemoteIdentity(result.stdout) : null
  } catch {
    // Repo creation must not fail because a best-effort remote probe failed.
    return null
  }
}
