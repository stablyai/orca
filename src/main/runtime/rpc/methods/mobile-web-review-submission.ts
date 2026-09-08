import type { HostedReviewSubmissionComment } from '../../../../shared/hosted-review-submission'
import type { MobileWebProviderReview } from '../../../../shared/mobile-web/provider-review-contract'
import type { z } from 'zod'
import {
  MobileWebProviderReviewSubmissionHostParamsSchema,
  type MobileWebProviderReviewQueuedComment,
  type MobileWebProviderReviewSubmissionResult
} from '../../../../shared/mobile-web/provider-review-submission-contract'
import { defineMethod, type RpcContext } from '../core'
import { projectMobileWebReview } from './mobile-web-review-projection'
import {
  assertMobileWebReviewIdentity,
  readMobileWebReviewTarget,
  type MobileWebReviewDetails,
  type MobileWebReviewPageResult
} from './mobile-web-review-scope'
import {
  gitHubReviewTarget,
  gitLabReviewTarget,
  reviewInlinePosition
} from './mobile-web-review-targets'

type LoadedDetails = Extract<MobileWebReviewDetails, { state: 'loaded' }>
type SubmissionParams = z.infer<typeof MobileWebProviderReviewSubmissionHostParamsSchema>

/** Posts a whole queued review at once. The provider rejects a comment on a line its diff does not
 *  expose, so the queue is checked against the review's own commentable lines first. */
export const MOBILE_WEB_REVIEW_SUBMIT_METHOD = defineMethod({
  name: 'mobileWeb.review.submit',
  params: MobileWebProviderReviewSubmissionHostParamsSchema,
  handler: async (
    params,
    context
  ): Promise<MobileWebReviewPageResult<MobileWebProviderReviewSubmissionResult>> => {
    const { repo, summary, details } = await readMobileWebReviewTarget(context, params)
    if (details.state !== 'loaded') {
      throw new Error('conflict')
    }
    const review = projectMobileWebReview(summary, details)
    if (
      review.headSha !== params.expectedReviewHead ||
      !review.allowedSubmissionActions.includes(params.action)
    ) {
      throw new Error('conflict')
    }
    const comments = retainedComments(review.files, params.comments)
    // Re-read after the provider round trips: a branch switch during them must not land a write.
    await assertMobileWebReviewIdentity(context, params)
    const result = await submitReview(context, repo, params, details, comments)
    if (
      !result.ok ||
      result.action !== params.action ||
      result.submittedComments !== comments.length
    ) {
      throw new Error('host_error')
    }
    return {
      provider: params.provider,
      reviewNumber: params.reviewNumber,
      expectedReviewHead: params.expectedReviewHead,
      submissionId: params.submissionId,
      action: params.action,
      submittedCommentIds: params.comments.map((comment) => comment.id),
      outcome: 'completed'
    }
  }
})

function retainedComments(
  files: MobileWebProviderReview['files'],
  comments: readonly MobileWebProviderReviewQueuedComment[]
): HostedReviewSubmissionComment[] {
  return comments.map((comment) => {
    const file = files.find((candidate) => candidate.path === comment.path)
    const startLine = comment.startLine ?? comment.line
    if (
      !file ||
      file.isBinary ||
      startLine > comment.line ||
      !file.commentableLines.includes(startLine) ||
      !file.commentableLines.includes(comment.line)
    ) {
      throw new Error('conflict')
    }
    return {
      body: comment.body,
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      line: comment.line,
      ...(comment.startLine ? { startLine: comment.startLine } : {})
    }
  })
}

async function submitReview(
  context: RpcContext,
  repo: string,
  payload: SubmissionParams,
  details: LoadedDetails,
  comments: HostedReviewSubmissionComment[]
) {
  const base = {
    repoSelector: repo,
    number: payload.reviewNumber,
    expectedHead: payload.expectedReviewHead,
    summary: payload.summary,
    comments
  }
  if (details.provider === 'github') {
    const repository = gitHubReviewTarget(details)
    if (!repository) {
      throw new Error('conflict')
    }
    return context.runtime.submitHostedReview({
      ...base,
      provider: 'github',
      action: payload.action,
      repository
    })
  }
  const projectRef = gitLabReviewTarget(details)
  const position = reviewInlinePosition(details, payload.expectedReviewHead)
  if (payload.action !== 'comment' || !projectRef || !position?.baseSha || !position.startSha) {
    throw new Error('conflict')
  }
  return context.runtime.submitHostedReview({
    ...base,
    provider: 'gitlab',
    action: payload.action,
    projectRef,
    baseSha: position.baseSha,
    startSha: position.startSha
  })
}
