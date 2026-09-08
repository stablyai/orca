import {
  MobileWebProviderReviewHostParamsSchema,
  type MobileWebProviderReviewResult
} from '../../../../shared/mobile-web/provider-review-contract'
import { defineMethod } from '../core'
import {
  assertMobileWebReviewIdentity,
  mobileWebReviewRepoSelector,
  readMobileWebReviewDetails,
  readMobileWebReviewSummary
} from './mobile-web-review-scope'
import { projectMobileWebReview } from './mobile-web-review-projection'

export const MOBILE_WEB_REVIEW_READ_METHOD = defineMethod({
  name: 'mobileWeb.review.read',
  params: MobileWebProviderReviewHostParamsSchema,
  handler: async (params, context): Promise<Omit<MobileWebProviderReviewResult, 'workspaceId'>> => {
    await assertMobileWebReviewIdentity(context, params)
    const repo = mobileWebReviewRepoSelector(params.worktree)
    const summary = await readMobileWebReviewSummary(context, repo, params)
    return {
      observedHead: params.expectedHead,
      branch: params.expectedBranch,
      review: summary
        ? projectMobileWebReview(summary, await readMobileWebReviewDetails(context, repo, summary))
        : null
    }
  }
})
