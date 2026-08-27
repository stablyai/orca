import type { HostedReviewWireInfo } from '../../shared/hosted-review'
import { hostedReviewInfoFromGitHubPRInfo } from '../../shared/hosted-review-github'
import { toPullRequestWireState } from '../../shared/github/pull-request-queue-state'
import type { PRInfo } from '../../shared/github/pull-request-types'
import type { MRInfo } from '../../shared/gitlab-types'
import type { AzureDevOpsPullRequestInfo } from '../azure-devops/pull-request-mappers'
import type { BitbucketPullRequestInfo } from '../bitbucket/pull-request-mappers'
import type { GiteaPullRequestInfo } from '../gitea/pull-request-mappers'

// Why: every mapper here returns the wire contract, so no provider — present or
// future — can publish a state an older client cannot read. Queue membership
// still travels, as `mergeQueueEntry`; the client re-derives `queued` from it
// (see `pull-request-queue-state.ts`). A provider gaining merge-queue or
// merge-train support must keep returning `HostedReviewWireInfo` and let the
// client derive `queued`, never widen this type.
export function mapGitHubReview(pr: PRInfo): HostedReviewWireInfo {
  return { ...hostedReviewInfoFromGitHubPRInfo(pr), state: toPullRequestWireState(pr.state) }
}

function mapGitLabReviewState(state: MRInfo['state']): HostedReviewWireInfo['state'] {
  if (state === 'opened' || state === 'locked') {
    return 'open'
  }
  return state
}

export function mapGitLabReview(mr: MRInfo): HostedReviewWireInfo {
  return {
    provider: 'gitlab',
    number: mr.number,
    title: mr.title,
    state: mapGitLabReviewState(mr.state),
    url: mr.url,
    status: mr.pipelineStatus,
    updatedAt: mr.updatedAt,
    mergeable: mr.mergeable,
    ...(mr.mergeStateStatus !== undefined ? { mergeStateStatus: mr.mergeStateStatus } : {}),
    ...(mr.headSha ? { headSha: mr.headSha } : {}),
    ...(mr.conflictSummary ? { conflictSummary: mr.conflictSummary } : {})
  }
}

export function mapBitbucketReview(pr: BitbucketPullRequestInfo): HostedReviewWireInfo {
  return {
    provider: 'bitbucket',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.status,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {})
  }
}

export function mapAzureDevOpsReview(pr: AzureDevOpsPullRequestInfo): HostedReviewWireInfo {
  return {
    provider: 'azure-devops',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.status,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {})
  }
}

export function mapGiteaReview(pr: GiteaPullRequestInfo): HostedReviewWireInfo {
  return {
    provider: 'gitea',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.status,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {})
  }
}
