import {
  MobileWebProviderReviewMutationResultSchema,
  type MobileWebProviderReview,
  type MobileWebProviderReviewMutationPayload,
  type MobileWebProviderReviewMutationResult
} from '../../../src/shared/mobile-web/provider-review-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  githubProviderReviewTarget,
  gitLabProviderReviewTarget
} from './mobile-web-provider-review-targets'

export async function executeMobileWebProviderReviewMutation(args: {
  client: RpcClient
  repo: string
  payload: MobileWebProviderReviewMutationPayload
  details: unknown
  review: MobileWebProviderReview
}): Promise<MobileWebProviderReviewMutationResult> {
  if (args.payload.action === 'comment') {
    await addProviderConversationComment(args.client, args.repo, args.payload, args.details)
  } else if (args.payload.action === 'reply') {
    await replyToProviderThread(args.client, args.repo, args.payload, args.details, args.review)
  } else if (args.payload.action === 'inlineComment') {
    await addProviderInlineComment(args.client, args.repo, args.payload, args.details, args.review)
  } else {
    await setProviderThreadResolved(args.client, args.repo, args.payload, args.details, args.review)
  }
  return MobileWebProviderReviewMutationResultSchema.parse(mutationResult(args.payload))
}

async function addProviderConversationComment(
  client: RpcClient,
  repo: string,
  payload: Extract<MobileWebProviderReviewMutationPayload, { action: 'comment' }>,
  details: unknown
): Promise<void> {
  const response =
    payload.provider === 'github'
      ? await client.sendRequest('github.addIssueComment', {
          repo,
          number: payload.reviewNumber,
          body: payload.body,
          ...githubProviderReviewTarget(details)
        })
      : payload.provider === 'gitlab'
        ? await client.sendRequest('gitlab.addMRComment', {
            repo,
            iid: payload.reviewNumber,
            body: payload.body,
            ...gitLabProviderReviewTarget(details)
          })
        : null
  assertStructuredMutationCompleted(response)
}

async function addProviderInlineComment(
  client: RpcClient,
  repo: string,
  payload: Extract<MobileWebProviderReviewMutationPayload, { action: 'inlineComment' }>,
  details: unknown,
  review: MobileWebProviderReview
): Promise<void> {
  const file = review.files.find((candidate) => candidate.path === payload.path)
  const startLine = payload.startLine ?? payload.line
  if (
    !file ||
    review.headSha !== payload.expectedReviewHead ||
    startLine > payload.line ||
    !file.commentableLines.includes(startLine) ||
    !file.commentableLines.includes(payload.line)
  ) {
    throw new MobileWebBrokerError('conflict')
  }
  const position = providerInlinePosition(details, payload.expectedReviewHead)
  if (!position) {
    throw new MobileWebBrokerError('conflict')
  }
  const response =
    payload.provider === 'github'
      ? await client.sendRequest('github.addPRReviewComment', {
          repo,
          prNumber: payload.reviewNumber,
          commitId: position.headSha,
          path: file.path,
          line: payload.line,
          ...(payload.startLine ? { startLine: payload.startLine } : {}),
          body: payload.body,
          ...githubProviderReviewTarget(details)
        })
      : payload.provider === 'gitlab' && position.baseSha && position.startSha
        ? await client.sendRequest('gitlab.addMRInlineComment', {
            repo,
            iid: payload.reviewNumber,
            input: {
              body: payload.body,
              path: file.path,
              ...(file.oldPath ? { oldPath: file.oldPath } : {}),
              line: payload.line,
              baseSha: position.baseSha,
              startSha: position.startSha,
              headSha: position.headSha
            },
            ...gitLabProviderReviewTarget(details)
          })
        : null
  assertStructuredMutationCompleted(response)
}

async function replyToProviderThread(
  client: RpcClient,
  repo: string,
  payload: Extract<MobileWebProviderReviewMutationPayload, { action: 'reply' }>,
  details: unknown,
  review: MobileWebProviderReview
): Promise<void> {
  if (payload.provider !== 'github') {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  const comment = review.comments.find(
    (candidate) =>
      candidate.id === payload.commentId &&
      candidate.threadId === payload.threadId &&
      candidate.allowedActions.includes('reply')
  )
  const commentId = positiveIntegerString(payload.commentId)
  if (!comment || commentId === null) {
    throw new MobileWebBrokerError('conflict')
  }
  const response = await client.sendRequest('github.addPRReviewCommentReply', {
    repo,
    prNumber: payload.reviewNumber,
    commentId,
    threadId: payload.threadId,
    body: payload.body,
    ...(comment.path ? { path: comment.path } : {}),
    ...(comment.line ? { line: comment.line } : {}),
    ...githubProviderReviewTarget(details)
  })
  assertStructuredMutationCompleted(response)
}

async function setProviderThreadResolved(
  client: RpcClient,
  repo: string,
  payload: Extract<MobileWebProviderReviewMutationPayload, { action: 'setThreadResolved' }>,
  details: unknown,
  review: MobileWebProviderReview
): Promise<void> {
  const comment = review.comments.find(
    (candidate) =>
      candidate.threadId === payload.threadId && candidate.allowedActions.includes('set-resolved')
  )
  if (!comment) {
    throw new MobileWebBrokerError('conflict')
  }
  if ((comment.threadState === 'resolved') === payload.resolved) {
    return
  }
  if (payload.provider === 'github') {
    const response = await client.sendRequest('github.resolveReviewThread', {
      repo,
      threadId: payload.threadId,
      resolve: payload.resolved,
      ...githubProviderReviewTarget(details)
    })
    if (!response.ok || response.result !== true) {
      throw new MobileWebBrokerError('host_error')
    }
    return
  }
  if (payload.provider === 'gitlab') {
    const response = await client.sendRequest('gitlab.resolveMRDiscussion', {
      repo,
      iid: payload.reviewNumber,
      discussionId: payload.threadId,
      resolved: payload.resolved,
      ...gitLabProviderReviewTarget(details)
    })
    assertStructuredMutationCompleted(response)
    return
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function assertStructuredMutationCompleted(
  response: Awaited<ReturnType<RpcClient['sendRequest']>> | null
): void {
  if (!response) {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  if (!response.ok || !isRecord(response.result) || response.result.ok !== true) {
    throw new MobileWebBrokerError('host_error')
  }
}

function mutationResult(
  payload: MobileWebProviderReviewMutationPayload
): MobileWebProviderReviewMutationResult {
  const base = {
    workspaceId: payload.workspaceId,
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
  return {
    ...base,
    action: payload.action,
    threadId: payload.threadId,
    resolved: payload.resolved
  }
}

function providerInlinePosition(
  details: unknown,
  expectedHead: string
): { headSha: string; baseSha?: string; startSha?: string } | null {
  if (!isRecord(details)) {
    return null
  }
  const headSha = boundedHead(details.headSha)
  if (headSha !== expectedHead) {
    return null
  }
  const baseSha = boundedHead(details.baseSha)
  const startSha = boundedHead(details.startSha)
  return {
    headSha,
    ...(baseSha ? { baseSha } : {}),
    ...(startSha ? { startSha } : {})
  }
}

function boundedHead(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ? value : null
}

function positiveIntegerString(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
