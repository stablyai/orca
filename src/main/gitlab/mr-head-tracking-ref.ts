import {
  gitlabMergeRequestHeadLocalRef,
  isSafeReviewHeadFetchRemote,
  isValidReviewHeadNumber,
  REVIEW_HEAD_FETCH_TIMEOUT_MS
} from '../../shared/review-head-tracking-ref'
import { gitExecFileAsync } from '../git/runner'
import { getReviewHeadRemoteComponent } from '../git/review-head-remote-identity'
import type { SshGitProvider } from '../providers/ssh-git-provider'

type LocalGitExecOptions = {
  cwd: string
  wslDistro?: string
}

// Why: the relay's read-only git.exec channel rejects `fetch`, so SSH repos
// must use the dedicated git.fetchGitLabMergeRequestHeadRef RPC. Mirrors
// fetchGitHubPullRequestHeadRef so both providers pin the durable head ref
// the same way.
export async function fetchGitLabMergeRequestHeadRef(
  repo: { path: string; connectionId?: string | null },
  sshGitProvider: SshGitProvider | null | undefined,
  remote: string,
  mrIid: number,
  options: { localGitExecOptions?: LocalGitExecOptions } = {}
): Promise<string> {
  if (!isValidReviewHeadNumber(mrIid)) {
    throw new Error(`Invalid merge request iid: ${mrIid}`)
  }
  if (!isSafeReviewHeadFetchRemote(remote)) {
    throw new Error('Merge request fetch remote must not start with "-".')
  }
  if (!repo.connectionId) {
    const localGitExecOptions = options.localGitExecOptions ?? { cwd: repo.path }
    const remoteComponent = await getReviewHeadRemoteComponent(remote, localGitExecOptions)
    // Why: return the same path the fetch wrote so callers don't re-resolve identity.
    const localRef = gitlabMergeRequestHeadLocalRef(remoteComponent, mrIid)
    await gitExecFileAsync(
      ['fetch', '--no-tags', remote, `+refs/merge-requests/${mrIid}/head:${localRef}`],
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
  return sshGitProvider.fetchGitLabMergeRequestHead(repo.path, remote, mrIid)
}
