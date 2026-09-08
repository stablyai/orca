import type { z } from 'zod'
import {
  MobileWebProviderReviewQueryHostParamsSchema,
  type MobileWebProviderReviewQueryResult
} from '../../../../shared/mobile-web/provider-review-query-contract'
import {
  MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT,
  type MobileWebProviderReview
} from '../../../../shared/mobile-web/provider-review-contract'
import { defineMethod, type RpcContext } from '../core'
import { clipMobileWebReviewCheckDetails } from './mobile-web-review-check-details'
import { projectMobileWebReview } from './mobile-web-review-projection'
import {
  readMobileWebReviewTarget,
  type MobileWebReviewDetails,
  type MobileWebReviewPageResult
} from './mobile-web-review-scope'

type GitHubDetails = Extract<MobileWebReviewDetails, { provider: 'github' }>
type QueryParams = z.infer<typeof MobileWebProviderReviewQueryHostParamsSchema>
type QueryResult = MobileWebReviewPageResult<MobileWebProviderReviewQueryResult>

/** Reads that only make sense once a review is on screen: who may be assigned to it, and the log
 *  of one of its checks. Both are GitHub-only today. */
export const MOBILE_WEB_REVIEW_QUERY_METHOD = defineMethod({
  name: 'mobileWeb.review.query',
  params: MobileWebProviderReviewQueryHostParamsSchema,
  handler: async (params, context): Promise<QueryResult> => {
    const { repo, summary, details } = await readMobileWebReviewTarget(context, params)
    if (details.state === 'unavailable') {
      throw new Error('conflict')
    }
    if (details.state !== 'loaded' || details.provider !== 'github') {
      throw new Error('unsupported_provider')
    }
    const identity = { provider: params.provider, reviewNumber: params.reviewNumber }
    return params.query === 'assignableUsers'
      ? { ...identity, query: params.query, users: await assignableUsers(context, repo) }
      : {
          ...identity,
          query: params.query,
          details: await checkDetails(
            context,
            repo,
            params,
            details,
            projectMobileWebReview(summary, details)
          )
        }
  }
})

async function assignableUsers(context: RpcContext, repo: string) {
  return (await context.runtime.listRepoAssignableUsers(repo))
    .slice(0, MOBILE_WEB_PROVIDER_REVIEW_USER_LIMIT)
    .map((user) => ({
      login: user.login.slice(0, 80),
      name: user.name?.slice(0, 160) ?? null
    }))
}

async function checkDetails(
  context: RpcContext,
  repo: string,
  payload: Extract<QueryParams, { query: 'checkDetails' }>,
  details: GitHubDetails,
  review: MobileWebProviderReview
) {
  const check = review.checks.find(
    (candidate) =>
      candidate.name === payload.checkName &&
      candidate.checkRunId === payload.checkRunId &&
      candidate.workflowRunId === payload.workflowRunId
  )
  if (!check) {
    throw new Error('conflict')
  }
  return clipMobileWebReviewCheckDetails(
    await context.runtime.getRepoPRCheckDetails(repo, {
      checkName: check.name,
      checkRunId: check.checkRunId,
      workflowRunId: check.workflowRunId,
      prRepo: details.item.item.prRepo ?? null
    })
  )
}
