import type { z } from 'zod'
import {
  MobileWebProviderReviewMutationHostParamsSchema,
  type MobileWebProviderReview,
  type MobileWebProviderReviewMutationResult
} from '../../../../shared/mobile-web/provider-review-contract'
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
type ReviewMutationParams = z.infer<typeof MobileWebProviderReviewMutationHostParamsSchema>
type ReviewMutationResult = MobileWebReviewPageResult<MobileWebProviderReviewMutationResult>
type MutationArgs = {
  context: RpcContext
  repo: string
  details: LoadedDetails
  review: MobileWebProviderReview
}

export const MOBILE_WEB_REVIEW_COMMENT_METHOD = defineMethod({
  name: 'mobileWeb.review.comment',
  params: MobileWebProviderReviewMutationHostParamsSchema,
  handler: async (params, context): Promise<ReviewMutationResult> => {
    const { repo, summary, details } = await readMobileWebReviewTarget(context, params)
    if (details.state !== 'loaded') {
      throw new Error('conflict')
    }
    const review = projectMobileWebReview(summary, details)
    // Re-read after the provider round trips: a branch switch during them must not land a write.
    await assertMobileWebReviewIdentity(context, params)
    await runReviewCommentMutation({ context, repo, details, review }, params)
    return mutationResult(params)
  }
})

async function runReviewCommentMutation(
  args: MutationArgs,
  payload: ReviewMutationParams
): Promise<void> {
  if (payload.action === 'comment') {
    return addConversationComment(args, payload)
  }
  if (payload.action === 'reply') {
    return replyToThread(args, payload)
  }
  if (payload.action === 'inlineComment') {
    return addInlineComment(args, payload)
  }
  return setThreadResolved(args, payload)
}

async function addConversationComment(
  args: MutationArgs,
  payload: Extract<ReviewMutationParams, { action: 'comment' }>
): Promise<void> {
  const { context, repo, details } = args
  if (details.provider === 'github') {
    return assertCompleted(
      await context.runtime.addRepoIssueComment(
        repo,
        payload.reviewNumber,
        payload.body,
        gitHubReviewTarget(details)
      )
    )
  }
  return assertCompleted(
    await context.runtime.addGitLabRepoMRComment(
      repo,
      payload.reviewNumber,
      payload.body,
      gitLabReviewTarget(details) ?? undefined
    )
  )
}

async function addInlineComment(
  args: MutationArgs,
  payload: Extract<ReviewMutationParams, { action: 'inlineComment' }>
): Promise<void> {
  const { context, repo, details, review } = args
  const file = review.files.find((candidate) => candidate.path === payload.path)
  const startLine = payload.startLine ?? payload.line
  if (
    !file ||
    review.headSha !== payload.expectedReviewHead ||
    startLine > payload.line ||
    !file.commentableLines.includes(startLine) ||
    !file.commentableLines.includes(payload.line)
  ) {
    throw new Error('conflict')
  }
  const position = reviewInlinePosition(details, payload.expectedReviewHead)
  if (!position) {
    throw new Error('conflict')
  }
  if (details.provider === 'github') {
    return assertCompleted(
      await context.runtime.addRepoPRReviewComment(repo, {
        prNumber: payload.reviewNumber,
        prRepo: gitHubReviewTarget(details),
        commitId: position.headSha,
        path: file.path,
        line: payload.line,
        ...(payload.startLine ? { startLine: payload.startLine } : {}),
        body: payload.body
      })
    )
  }
  const projectRef = gitLabReviewTarget(details)
  if (!position.baseSha || !position.startSha) {
    throw new Error('conflict')
  }
  return assertCompleted(
    await context.runtime.addGitLabRepoMRInlineComment(
      repo,
      payload.reviewNumber,
      {
        body: payload.body,
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        line: payload.line,
        baseSha: position.baseSha,
        startSha: position.startSha,
        headSha: position.headSha
      },
      projectRef ?? undefined
    )
  )
}

/** Only GitHub threads accept a reply, and it is addressed by the provider's numeric comment id,
 *  which is why the page's opaque id is matched back to the comment it was projected from. */
async function replyToThread(
  args: MutationArgs,
  payload: Extract<ReviewMutationParams, { action: 'reply' }>
): Promise<void> {
  const { context, repo, details, review } = args
  if (details.provider !== 'github') {
    throw new Error('unsupported_provider')
  }
  const projected = review.comments.find(
    (candidate) =>
      candidate.id === payload.commentId &&
      candidate.threadId === payload.threadId &&
      candidate.allowedActions.includes('reply')
  )
  const source = details.item.comments.find(
    (candidate) => String(candidate.id) === payload.commentId
  )
  if (!projected || !source) {
    throw new Error('conflict')
  }
  return assertCompleted(
    await context.runtime.addRepoPRReviewCommentReply(repo, {
      prNumber: payload.reviewNumber,
      commentId: source.id,
      threadId: payload.threadId,
      body: payload.body,
      ...(projected.path ? { path: projected.path } : {}),
      ...(projected.line ? { line: projected.line } : {}),
      prRepo: gitHubReviewTarget(details)
    })
  )
}

async function setThreadResolved(
  args: MutationArgs,
  payload: Extract<ReviewMutationParams, { action: 'setThreadResolved' }>
): Promise<void> {
  const { context, repo, details, review } = args
  const comment = review.comments.find(
    (candidate) =>
      candidate.threadId === payload.threadId && candidate.allowedActions.includes('set-resolved')
  )
  if (!comment) {
    throw new Error('conflict')
  }
  if ((comment.threadState === 'resolved') === payload.resolved) {
    return
  }
  if (details.provider === 'github') {
    const resolved = await context.runtime.resolveRepoReviewThread(
      repo,
      payload.threadId,
      payload.resolved,
      gitHubReviewTarget(details)
    )
    if (!resolved) {
      throw new Error('host_error')
    }
    return
  }
  return assertCompleted(
    await context.runtime.resolveGitLabRepoMRDiscussion(
      repo,
      payload.reviewNumber,
      payload.threadId,
      payload.resolved,
      gitLabReviewTarget(details) ?? undefined
    )
  )
}

function assertCompleted(result: { ok: boolean }): void {
  if (!result.ok) {
    throw new Error('host_error')
  }
}

function mutationResult(payload: ReviewMutationParams): ReviewMutationResult {
  const base = {
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    outcome: 'completed' as const
  }
  if (payload.action === 'comment') {
    return { ...base, action: payload.action }
  }
  if (payload.action === 'reply') {
    return {
      ...base,
      action: payload.action,
      commentId: payload.commentId,
      threadId: payload.threadId
    }
  }
  if (payload.action === 'inlineComment') {
    return {
      ...base,
      action: payload.action,
      expectedReviewHead: payload.expectedReviewHead,
      path: payload.path,
      line: payload.line,
      ...(payload.startLine ? { startLine: payload.startLine } : {})
    }
  }
  return { ...base, action: payload.action, threadId: payload.threadId, resolved: payload.resolved }
}
