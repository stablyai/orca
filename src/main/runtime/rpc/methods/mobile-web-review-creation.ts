import {
  MobileWebProviderReviewCreateHostParamsSchema,
  MobileWebProviderReviewEligibilityHostParamsSchema,
  MobileWebProviderReviewEligibilityResultSchema,
  MobileWebProviderReviewFieldsHostParamsSchema,
  type MobileWebProviderReviewCreateResult,
  type MobileWebProviderReviewFieldsResult
} from '../../../../shared/mobile-web/provider-review-creation-contract'
import { defineMethod, type RpcContext } from '../core'
import {
  assertMobileWebReviewIdentity,
  mobileWebReviewRepoSelector,
  type MobileWebReviewPageResult
} from './mobile-web-review-scope'
import { readMobileWebReviewCreationSnapshot } from './mobile-web-review-creation-snapshot'
import {
  clipMobileWebReviewCreateResult,
  clipMobileWebReviewEligibility
} from './mobile-web-review-creation-clip'

/** What a creation call must name about the repository it was composed against. */
type ReviewCreationIdentity = {
  worktree: string
  expectedHead: string
  expectedBranch: string
  base?: string | null
}

const ELIGIBILITY_METHOD = defineMethod({
  name: 'mobileWeb.review.creationEligibility',
  params: MobileWebProviderReviewEligibilityHostParamsSchema,
  handler: async (params, context) => readEligibility(context, params)
})

const CREATE_METHOD = defineMethod({
  name: 'mobileWeb.review.create',
  params: MobileWebProviderReviewCreateHostParamsSchema,
  handler: async (
    params,
    context
  ): Promise<MobileWebReviewPageResult<MobileWebProviderReviewCreateResult>> => {
    const eligibility = await readEligibility(context, params)
    if (
      !eligibility.canCreate ||
      eligibility.reviewLookupOutcome !== 'not_found' ||
      eligibility.provider !== params.provider
    ) {
      throw new Error('conflict')
    }
    // Re-read after the eligibility round trip: creating from a moved head is not what was asked.
    await assertMobileWebReviewIdentity(context, params)
    const result = await context.runtime.createHostedReview({
      repoSelector: mobileWebReviewRepoSelector(params.worktree),
      worktreeSelector: params.worktree,
      provider: params.provider,
      base: params.base,
      head: params.head,
      title: params.title,
      body: params.body,
      draft: params.draft,
      ...(params.useTemplate === undefined ? {} : { useTemplate: params.useTemplate })
    })
    return { provider: params.provider, ...clipMobileWebReviewCreateResult(result) }
  }
})

const GENERATE_FIELDS_METHOD = defineMethod({
  name: 'mobileWeb.review.generateFields',
  params: MobileWebProviderReviewFieldsHostParamsSchema,
  handler: async (
    params,
    context
  ): Promise<MobileWebReviewPageResult<MobileWebProviderReviewFieldsResult>> => {
    await assertMobileWebReviewIdentity(context, params)
    const result = await context.runtime.generateRuntimePullRequestFields(params.worktree, {
      base: params.base,
      title: params.title,
      body: params.body,
      draft: params.draft
    })
    return result.success
      ? {
          success: true,
          fields: {
            base: result.fields.base,
            title: result.fields.title.slice(0, 512),
            body: result.fields.body.slice(0, 32 * 1024),
            draft: result.fields.draft
          }
        }
      : { success: false, error: result.error.slice(0, 1024) }
  }
})

async function readEligibility(context: RpcContext, params: ReviewCreationIdentity) {
  const snapshot = await readMobileWebReviewCreationSnapshot(context, params.worktree)
  if (snapshot.head !== params.expectedHead || snapshot.branch !== params.expectedBranch) {
    throw new Error('conflict')
  }
  const eligibility = await context.runtime.getHostedReviewCreationEligibility({
    repoSelector: mobileWebReviewRepoSelector(params.worktree),
    worktreeSelector: params.worktree,
    branch: params.expectedBranch,
    base: params.base ?? null,
    hasUncommittedChanges: snapshot.hasUncommittedChanges,
    hasUpstream: snapshot.upstream.hasUpstream,
    ahead: snapshot.upstream.ahead,
    behind: snapshot.upstream.behind,
    ...snapshot.links
  })
  // The one assertion: the clips above have to leave a result the page contract accepts.
  return MobileWebProviderReviewEligibilityResultSchema.omit({ workspaceId: true }).parse({
    observedHead: params.expectedHead,
    branch: params.expectedBranch,
    ...clipMobileWebReviewEligibility(eligibility)
  })
}

export const MOBILE_WEB_REVIEW_CREATION_METHODS = [
  ELIGIBILITY_METHOD,
  CREATE_METHOD,
  GENERATE_FIELDS_METHOD
]
