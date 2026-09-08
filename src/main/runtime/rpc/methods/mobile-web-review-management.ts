import type { z } from 'zod'
import {
  MobileWebProviderReviewManagementHostParamsSchema,
  type MobileWebProviderReviewManagementResult
} from '../../../../shared/mobile-web/provider-review-management-contract'
import type { MobileWebProviderReview } from '../../../../shared/mobile-web/provider-review-contract'
import type { GitHubWorkItemDetails } from '../../../../shared/github/work-item-types'
import { defineMethod, type RpcContext } from '../core'
import { projectMobileWebReview } from './mobile-web-review-projection'
import {
  assertMobileWebReviewIdentity,
  readMobileWebReviewTarget,
  type MobileWebReviewDetails,
  type MobileWebReviewPageResult
} from './mobile-web-review-scope'

type GitHubDetails = Extract<MobileWebReviewDetails, { provider: 'github' }>
type ManagementParams = z.infer<typeof MobileWebProviderReviewManagementHostParamsSchema>
type ManagementArgs = {
  context: RpcContext
  repo: string
  details: GitHubDetails
  review: MobileWebProviderReview
}

/** Merging, reviewer assignment and check reruns exist only on GitHub today; every other provider
 *  reaches this method with a review it cannot manage. */
export const MOBILE_WEB_REVIEW_MANAGE_METHOD = defineMethod({
  name: 'mobileWeb.review.manage',
  params: MobileWebProviderReviewManagementHostParamsSchema,
  handler: async (
    params,
    context
  ): Promise<MobileWebReviewPageResult<MobileWebProviderReviewManagementResult>> => {
    const { repo, summary, details } = await readMobileWebReviewTarget(context, params)
    if (details.state !== 'loaded') {
      throw new Error('conflict')
    }
    if (details.provider !== 'github') {
      throw new Error('unsupported_provider')
    }
    const review = projectMobileWebReview(summary, details)
    // Re-read after the provider round trips: a branch switch during them must not land a write.
    await assertMobileWebReviewIdentity(context, params)
    await manageGitHubReview({ context, repo, details, review }, params)
    return {
      provider: params.provider,
      reviewNumber: params.reviewNumber,
      action: params.action,
      outcome: 'completed'
    }
  }
})

async function manageGitHubReview(args: ManagementArgs, payload: ManagementParams): Promise<void> {
  const { context, repo, details, review } = args
  const runtime = context.runtime
  const prRepo = details.item.item.prRepo ?? null
  if (payload.action === 'merge') {
    return assertCompleted(
      await runtime.mergeRepoPR(repo, payload.reviewNumber, payload.method, prRepo)
    )
  }
  if (payload.action === 'setAutoMerge') {
    return assertCompleted(
      await runtime.setRepoPRAutoMerge(
        repo,
        payload.reviewNumber,
        payload.enabled,
        payload.method,
        prRepo
      )
    )
  }
  if (payload.action === 'setState') {
    return assertCompleted(
      await runtime.updateRepoPRState(repo, payload.reviewNumber, { state: payload.state }, prRepo)
    )
  }
  if (payload.action === 'requestReviewers' || payload.action === 'removeReviewers') {
    await assertAssignableReviewers(context, repo, payload.reviewers)
    return assertCompleted(
      payload.action === 'requestReviewers'
        ? await runtime.requestRepoPRReviewers(
            repo,
            payload.reviewNumber,
            payload.reviewers,
            prRepo
          )
        : await runtime.removeRepoPRReviewers(repo, payload.reviewNumber, payload.reviewers, prRepo)
    )
  }
  if (payload.action === 'rerunChecks') {
    if (payload.expectedReviewHead && payload.expectedReviewHead !== review.headSha) {
      throw new Error('conflict')
    }
    return assertCompleted(
      await runtime.rerunRepoPRChecks(repo, payload.reviewNumber, {
        headSha: review.headSha,
        failedOnly: payload.failedOnly,
        prRepo
      })
    )
  }
  if (payload.action === 'updateTitle') {
    const updated = await runtime.updateRepoPRTitle(
      repo,
      payload.reviewNumber,
      payload.title,
      prRepo
    )
    if (!updated) {
      throw new Error('host_error')
    }
    return
  }
  return mutateConversationComment(args, payload, prRepo)
}

/** The conversation-comment endpoints address the pull request's own repository slug and the
 *  provider's numeric comment id, so the page's opaque id is matched back to its source comment. */
async function mutateConversationComment(
  args: ManagementArgs,
  payload: Extract<
    ManagementParams,
    { action: 'updateConversationComment' | 'deleteConversationComment' }
  >,
  prRepo: GitHubWorkItemDetails['item']['prRepo'] | null
): Promise<void> {
  const projected = args.review.comments.find(
    (candidate) => candidate.id === payload.commentId && candidate.kind === 'conversation'
  )
  const source = args.details.item.comments.find(
    (candidate) => String(candidate.id) === payload.commentId
  )
  if (!projected || !source || !prRepo) {
    throw new Error('conflict')
  }
  const target = { ...prRepo, commentId: source.id }
  return assertCompleted(
    payload.action === 'updateConversationComment'
      ? await args.context.runtime.updateGitHubIssueCommentBySlug({ ...target, body: payload.body })
      : await args.context.runtime.deleteGitHubIssueCommentBySlug(target)
  )
}

async function assertAssignableReviewers(
  context: RpcContext,
  repo: string,
  reviewers: string[]
): Promise<void> {
  const assignable = new Set(
    (await context.runtime.listRepoAssignableUsers(repo)).map((user) => user.login.toLowerCase())
  )
  if (reviewers.some((reviewer) => !assignable.has(reviewer.toLowerCase()))) {
    throw new Error('conflict')
  }
}

function assertCompleted(result: { ok: boolean }): void {
  if (!result.ok) {
    throw new Error('host_error')
  }
}
