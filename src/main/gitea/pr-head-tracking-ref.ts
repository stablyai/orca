import { gitExecFileAsync } from '../git/runner'
import {
  giteaPullRequestHeadLocalRef,
  isSafeReviewHeadFetchRemote,
  isValidReviewHeadNumber,
  REVIEW_HEAD_FETCH_TIMEOUT_MS
} from '../../shared/review-head-tracking-ref'
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

export async function fetchGiteaPullRequestHeadRef(
  repo: { path: string } & Pick<Repo, 'connectionId' | 'executionHostId'>,
  remote: string,
  prNumber: number,
  options: { localGitExecOptions?: LocalGitExecOptions } = {}
): Promise<string> {
  if (!isValidReviewHeadNumber(prNumber)) {
    throw new Error(`Invalid pull request number: ${String(prNumber)}`)
  }
  if (!isSafeReviewHeadFetchRemote(remote)) {
    throw new Error('Pull request fetch remote must not start with "-".')
  }
  const sshTargetId = getRepoRoutingConnectionId(repo)
  if (sshTargetId) {
    throw new SshHostNotServedError(sshTargetId, SSH_GIT_RECONNECT_MESSAGE)
  }
  const localGitExecOptions = options.localGitExecOptions ?? { cwd: repo.path }
  const remoteComponent = await getReviewHeadRemoteComponent(remote, localGitExecOptions)
  const localRef = giteaPullRequestHeadLocalRef(remoteComponent, prNumber)
  await gitExecFileAsync(
    ['fetch', '--no-tags', remote, `+refs/pull/${prNumber}/head:${localRef}`],
    { ...localGitExecOptions, timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
  )
  return localRef
}
