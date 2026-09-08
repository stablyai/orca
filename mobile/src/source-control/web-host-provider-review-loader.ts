import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { MobileWebProviderReviewResult } from '../../../src/shared/mobile-web/provider-review-contract'
import {
  loadWebHostProviderReviewEligibility,
  takeWebHostProviderReviewEligibility,
  type WebHostProviderReviewEligibilityCache
} from './web-host-provider-review-creation'
import type { WebHostSourceControlStatusSnapshot } from './web-host-source-control-status-snapshot'

export type WebHostProviderReviewCache = {
  key: string | null
  result: MobileWebProviderReviewResult | null
  commentIds: Map<number, string>
}

export function createWebHostProviderReviewCache(): WebHostProviderReviewCache {
  return { key: null, result: null, commentIds: new Map() }
}

export async function readWebHostGitHubRepositoryEligibility(
  client: MobileWebBridgeClient,
  workspaceId: string,
  cache: WebHostProviderReviewEligibilityCache,
  statusSnapshot: WebHostSourceControlStatusSnapshot
) {
  const status = await statusSnapshot.read()
  if (!status.head || !status.branch) {
    throw new Error('conflict')
  }
  const eligibility = await loadWebHostProviderReviewEligibility({
    client,
    identity: {
      workspaceId,
      expectedHead: status.head,
      expectedBranch: status.branch
    },
    cache
  })
  return eligibility.provider === 'github' ? { owner: 'paired-host', repo: 'workspace' } : null
}

export async function loadWebHostProviderReview(
  client: MobileWebBridgeClient,
  workspaceId: string,
  cache: WebHostProviderReviewCache,
  eligibilityCache: WebHostProviderReviewEligibilityCache,
  statusSnapshot: WebHostSourceControlStatusSnapshot
): Promise<MobileWebProviderReviewResult> {
  const status = await statusSnapshot.read()
  if (!status.head || !status.branch) {
    throw new Error('conflict')
  }
  const key = `${status.head}\0${status.branch}`
  if (cache.key === key && cache.result) {
    return cache.result
  }
  const eligibility = takeWebHostProviderReviewEligibility(eligibilityCache, {
    expectedHead: status.head,
    expectedBranch: status.branch
  })
  if (eligibility?.review === null) {
    const result = {
      workspaceId,
      observedHead: status.head,
      branch: status.branch,
      review: null
    }
    cache.key = key
    cache.result = result
    return result
  }
  const result = await client.providerReview({
    workspaceId,
    expectedHead: status.head,
    expectedBranch: status.branch
  })
  cache.key = key
  cache.result = result
  cache.commentIds.clear()
  result.review?.comments.forEach((comment, index) => {
    cache.commentIds.set(index + 1, comment.id)
  })
  return result
}
