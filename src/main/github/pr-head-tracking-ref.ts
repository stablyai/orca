import { gitExecFileAsync } from '../git/runner'
import {
  githubPullRequestHeadLocalRef,
  isSafeReviewHeadFetchRemote,
  isValidReviewHeadNumber,
  REVIEW_HEAD_FETCH_TIMEOUT_MS
} from '../../shared/review-head-tracking-ref'
import { getReviewHeadRemoteComponent } from '../git/review-head-remote-identity'
import type { SshGitProvider } from '../providers/ssh-git-provider'

type LocalGitExecOptions = {
  cwd: string
  wslDistro?: string
}

// Why: the relay's read-only git.exec channel rejects `fetch`, so SSH repos
// must use the dedicated git.fetchRemoteTrackingRef RPC.
export async function fetchPrHeadTrackingRef(
  repo: { path: string; connectionId?: string | null },
  sshGitProvider: SshGitProvider | null | undefined,
  remote: string,
  branch: string,
  options: { localGitExecOptions?: LocalGitExecOptions } = {}
): Promise<void> {
  const ref = `refs/remotes/${remote}/${branch}`
  if (!repo.connectionId) {
    await gitExecFileAsync(
      ['fetch', remote, `+refs/heads/${branch}:${ref}`],
      options.localGitExecOptions ?? { cwd: repo.path }
    )
    return
  }
  if (!sshGitProvider) {
    throw new Error('SSH Git provider is not available. Reconnect to this target and try again.')
  }
  await sshGitProvider.fetchRemoteTrackingRef(repo.path, remote, branch, ref)
}

export async function fetchGitHubPullRequestHeadRef(
  repo: { path: string; connectionId?: string | null },
  sshGitProvider: SshGitProvider | null | undefined,
  remote: string,
  prNumber: number,
  options: { localGitExecOptions?: LocalGitExecOptions } = {}
): Promise<string> {
  if (!isValidReviewHeadNumber(prNumber)) {
    throw new Error(`Invalid pull request number: ${prNumber}`)
  }
  if (!isSafeReviewHeadFetchRemote(remote)) {
    throw new Error('Pull request fetch remote must not start with "-".')
  }
  if (!repo.connectionId) {
    const localGitExecOptions = options.localGitExecOptions ?? { cwd: repo.path }
    const remoteComponent = await getReviewHeadRemoteComponent(remote, localGitExecOptions)
    // Why: return the same path the fetch wrote so callers don't re-resolve identity.
    const localRef = githubPullRequestHeadLocalRef(remoteComponent, prNumber)
    await gitExecFileAsync(
      ['fetch', '--no-tags', remote, `+refs/pull/${prNumber}/head:${localRef}`],
      {
        ...localGitExecOptions,
        timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS
      }
    )
    return localRef
  }
  if (!sshGitProvider) {
    throw new Error('SSH Git provider is not available. Reconnect to this target and try again.')
  }
  return sshGitProvider.fetchGitHubPullRequestHead(repo.path, remote, prNumber)
}
