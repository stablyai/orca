import {
  MobileWebTaskItemCommentPayloadSchema,
  MobileWebTaskItemCommentResultSchema,
  MobileWebTaskItemMergePayloadSchema,
  MobileWebTaskItemReviewersPayloadSchema,
  MobileWebTaskItemReviewMutationResultSchema,
  MobileWebTaskItemReviewReplyPayloadSchema,
  MobileWebTaskItemReviewThreadPayloadSchema
} from '../../../src/shared/mobile-web/task-item-review-contract'
import type {
  MobileWebTaskGitHubDetailResult,
  MobileWebTaskGitLabDetailResult
} from '../../../src/shared/mobile-web/task-detail-contract'
import { nativeHostTaskDetailOperations } from '../tasks/native-host-task-detail-operations'
import { nativeHostTaskItemReviewOperations } from '../tasks/native-host-task-item-review-operations'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type {
  MobileWebHostedTaskTarget,
  MobileWebTaskTargetAuthority
} from './mobile-web-task-target-authority'

const OPERATIONS = new Set([
  'addHostedTaskComment',
  'requestHostedTaskReviewers',
  'resolveHostedTaskReviewThread',
  'replyHostedTaskReviewComment',
  'mergeHostedTaskReview'
])

type FreshDetails = MobileWebTaskGitHubDetailResult | MobileWebTaskGitLabDetailResult

export async function executeMobileWebTaskItemReviewOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  targetAuthority: MobileWebTaskTargetAuthority
}): Promise<{ handled: boolean; result?: unknown }> {
  if (!OPERATIONS.has(args.operation)) {
    return { handled: false }
  }
  const pageTargetId = targetId(args.operation, args.payload)
  const target = args.targetAuthority.resolveHosted(pageTargetId)
  const details = await freshDetails(args.client, target)
  args.targetAuthority.assertHostedTarget(pageTargetId, target)
  const operations = nativeHostTaskItemReviewOperations(args.client)
  if (args.operation === 'addHostedTaskComment') {
    const payload = MobileWebTaskItemCommentPayloadSchema.parse(args.payload)
    return {
      handled: true,
      result: MobileWebTaskItemCommentResultSchema.parse({
        comment: await operations.addComment(target, payload.body)
      })
    }
  }
  if (args.operation === 'mergeHostedTaskReview') {
    const payload = MobileWebTaskItemMergePayloadSchema.parse(args.payload)
    requireReview(target)
    await operations.merge(target, payload.method)
    return done()
  }
  const gitHubTarget = requireGitHubPullRequest(target)
  if (args.operation === 'requestHostedTaskReviewers') {
    const payload = MobileWebTaskItemReviewersPayloadSchema.parse(args.payload)
    await operations.requestReviewers(gitHubTarget, payload.reviewers)
  } else if (args.operation === 'resolveHostedTaskReviewThread') {
    const payload = MobileWebTaskItemReviewThreadPayloadSchema.parse(args.payload)
    requireThread(details, payload.threadId)
    await operations.resolveThread(gitHubTarget, payload.threadId, payload.resolve)
  } else if (args.operation === 'replyHostedTaskReviewComment') {
    const payload = MobileWebTaskItemReviewReplyPayloadSchema.parse(args.payload)
    requireComment(details, payload.commentId, payload.threadId)
    await operations.replyReviewComment(gitHubTarget, {
      commentId: payload.commentId,
      body: payload.body,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
      ...(payload.path ? { path: payload.path } : {}),
      ...(payload.line ? { line: payload.line } : {})
    })
  }
  return done()
}

async function freshDetails(
  client: RpcClient,
  target: MobileWebHostedTaskTarget
): Promise<FreshDetails> {
  const operations = nativeHostTaskDetailOperations(client)
  return target.provider === 'github'
    ? operations.loadGitHub(target)
    : operations.loadGitLab(target)
}

function requireGitHubPullRequest(
  target: MobileWebHostedTaskTarget
): Extract<MobileWebHostedTaskTarget, { provider: 'github' }> {
  if (target.provider !== 'github' || target.type !== 'pr') {
    throw new MobileWebBrokerError('invalid_request')
  }
  return target
}

function requireReview(target: MobileWebHostedTaskTarget): void {
  if (
    (target.provider === 'github' && target.type !== 'pr') ||
    (target.provider === 'gitlab' && target.type !== 'mr')
  ) {
    throw new MobileWebBrokerError('invalid_request')
  }
}

function requireThread(details: FreshDetails, threadId: string): void {
  if (!details.comments.some((comment) => comment.threadId === threadId)) {
    throw new MobileWebBrokerError('conflict')
  }
}

function requireComment(details: FreshDetails, commentId: number, threadId?: string): void {
  if (
    !details.comments.some(
      (comment) => Number(comment.id) === commentId && (!threadId || comment.threadId === threadId)
    )
  ) {
    throw new MobileWebBrokerError('conflict')
  }
}

function targetId(operation: string, payload: unknown): string {
  const schema =
    operation === 'addHostedTaskComment'
      ? MobileWebTaskItemCommentPayloadSchema
      : operation === 'requestHostedTaskReviewers'
        ? MobileWebTaskItemReviewersPayloadSchema
        : operation === 'resolveHostedTaskReviewThread'
          ? MobileWebTaskItemReviewThreadPayloadSchema
          : operation === 'replyHostedTaskReviewComment'
            ? MobileWebTaskItemReviewReplyPayloadSchema
            : MobileWebTaskItemMergePayloadSchema
  return schema.parse(payload).targetId
}

function done(): { handled: true; result: null } {
  return {
    handled: true,
    result: MobileWebTaskItemReviewMutationResultSchema.parse(null)
  }
}
