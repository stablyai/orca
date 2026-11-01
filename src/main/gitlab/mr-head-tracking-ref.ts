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
import { getRepoRoutingConnectionId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'

type LocalGitExecOptions = {
  cwd: string
  wslDistro?: string
}

export async function fetchGitLabMergeRequestHeadRef(
  repo: { path: string } & Pick<Repo, 'connectionId' | 'executionHostId'>,
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
  const sshTargetId = getRepoRoutingConnectionId(repo)
  if (sshTargetId) {
    throw new SshHostNotServedError(sshTargetId, SSH_GIT_RECONNECT_MESSAGE)
  }
  const localGitExecOptions = options.localGitExecOptions ?? { cwd: repo.path }
  const remoteComponent = await getReviewHeadRemoteComponent(remote, localGitExecOptions)
  // Return the written ref so callers do not recompute its identity.
  const localRef = gitlabMergeRequestHeadLocalRef(remoteComponent, mrIid)
  await gitExecFileAsync(
    ['fetch', '--no-tags', remote, `+refs/merge-requests/${mrIid}/head:${localRef}`],
    { ...localGitExecOptions, timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
  )
  return localRef
}
