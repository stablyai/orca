import type { MobileWebProviderReview } from '../../../src/shared/mobile-web/provider-review-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { sanitizeMobileWebProviderReviewSummary } from './mobile-web-provider-review-sanitizer'
import { readMobileWebSourceControlStatusIdentity } from './mobile-web-source-control-repository-state'
import { assertMobileWebRepositoryIdentity } from './mobile-web-source-control-sync-preflight'

export async function assertCurrentRepositoryIdentity(
  client: RpcClient,
  hostWorkspaceId: string,
  expected: {
    workspaceId: string
    expectedHead: string
    expectedBranch: string
  }
): Promise<void> {
  const identity = await readMobileWebSourceControlStatusIdentity(client, hostWorkspaceId)
  assertMobileWebRepositoryIdentity(identity, expected)
}

export async function readHostedReviewSummary(
  client: RpcClient,
  repo: string,
  identity: {
    expectedHead: string
    expectedBranch: string
  }
): Promise<Omit<
  MobileWebProviderReview,
  | 'body'
  | 'comments'
  | 'commentsTruncated'
  | 'files'
  | 'filesTruncated'
  | 'author'
  | 'reviewRequests'
  | 'latestReviews'
  | 'checks'
  | 'detailsState'
  | 'canComment'
  | 'allowedSubmissionActions'
> | null> {
  const response = await client.sendRequest('hostedReview.forBranch', {
    repo,
    branch: identity.expectedBranch,
    currentHeadOid: identity.expectedHead
  })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  if (response.result === null) {
    return null
  }
  const summary = sanitizeMobileWebProviderReviewSummary(response.result)
  if (!summary) {
    throw new MobileWebBrokerError('host_error')
  }
  return summary
}

export async function readProviderDetails(
  client: RpcClient,
  repo: string,
  review: Pick<MobileWebProviderReview, 'provider' | 'number'>
): Promise<unknown> {
  if (review.provider === 'github') {
    const response = await client.sendRequest('github.workItemDetails', {
      repo,
      number: review.number,
      type: 'pr'
    })
    return response.ok ? response.result : null
  }
  if (review.provider === 'gitlab') {
    const response = await client.sendRequest('gitlab.workItemDetails', {
      repo,
      iid: review.number,
      type: 'mr'
    })
    return response.ok ? response.result : null
  }
  return null
}
