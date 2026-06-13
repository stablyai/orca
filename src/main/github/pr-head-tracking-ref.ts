import { gitExecFileAsync } from '../git/runner'
import type { SshGitProvider } from '../providers/ssh-git-provider'

// Why: the relay's read-only git.exec channel rejects `fetch`, so SSH repos
// must use the dedicated git.fetchRemoteTrackingRef RPC.
export async function fetchPrHeadTrackingRef(
  repo: { path: string; connectionId?: string | null },
  sshGitProvider: SshGitProvider | null | undefined,
  remote: string,
  branch: string
): Promise<void> {
  const ref = `refs/remotes/${remote}/${branch}`
  if (!repo.connectionId) {
    await gitExecFileAsync(['fetch', remote, `+refs/heads/${branch}:${ref}`], { cwd: repo.path })
    return
  }
  if (!sshGitProvider) {
    throw new Error('SSH Git provider is not available. Reconnect to this target and try again.')
  }
  await sshGitProvider.fetchRemoteTrackingRef(repo.path, remote, branch, ref)
}
