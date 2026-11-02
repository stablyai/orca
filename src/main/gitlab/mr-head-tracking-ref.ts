import {
  gitlabMergeRequestHeadLocalRef,
  isSafeReviewHeadFetchRemote,
  isValidReviewHeadNumber,
  REVIEW_HEAD_FETCH_TIMEOUT_MS
} from '../../shared/review-head-tracking-ref'
import { gitExecFileAsync } from '../git/runner'
import { getReviewHeadRemoteComponent } from '../git/review-head-remote-identity'
import {
  SSH_GIT_RECONNECT_MESSAGE,
  SshHostNotServedError
} from '../providers/ssh-host-not-served-error'

type LocalGitExecOptions = {
  cwd: string
  wslDistro?: string
}

// Why: mirrors fetchGitHubPullRequestHeadRef so both forges pin the durable head ref the same way.
export async function fetchGitLabMergeRequestHeadRef(
  repo: { path: string; connectionId?: string | null },
  remote: string,
  mrIid: number,
  options: { localGitExecOptions?: LocalGitExecOptions } = {}
): Promise<string> {
  if (!isValidReviewHeadNumber(mrIid)) {
    throw new Error(`Invalid merge request iid: ${String(mrIid)}`)
  }
  if (!isSafeReviewHeadFetchRemote(remote)) {
    throw new Error('Merge request fetch remote must not start with "-".')
  }
  if (repo.connectionId) {
    throw new SshHostNotServedError(repo.connectionId, SSH_GIT_RECONNECT_MESSAGE)
  }
  const localGitExecOptions = options.localGitExecOptions ?? { cwd: repo.path }
  const remoteComponent = await getReviewHeadRemoteComponent(remote, localGitExecOptions)
  // Why: return the same path the fetch wrote so callers don't re-resolve identity.
  const localRef = gitlabMergeRequestHeadLocalRef(remoteComponent, mrIid)
  await gitExecFileAsync(
    ['fetch', '--no-tags', remote, `+refs/merge-requests/${mrIid}/head:${localRef}`],
    { ...localGitExecOptions, timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
  )
  return localRef
}
