import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type {
  MobileWebProviderReview,
  MobileWebProviderReviewResult
} from '../../../src/shared/mobile-web/provider-review-contract'

type RequestParams = Record<string, unknown>

export const WEB_HOST_PROVIDER_REVIEW_MUTATION_METHODS = new Set([
  'github.addIssueComment',
  'github.addPRReviewCommentReply',
  'github.resolveReviewThread',
  'github.mergePR',
  'github.setPRAutoMerge',
  'github.updatePRState',
  'github.requestPRReviewers',
  'github.removePRReviewers',
  'github.rerunPRChecks',
  'github.updatePRTitle',
  'github.project.updateIssueCommentBySlug',
  'github.project.deleteIssueCommentBySlug'
])

export async function handleWebHostProviderReviewMutation(args: {
  client: MobileWebBridgeClient
  workspaceId: string
  method: string
  params: RequestParams
  loaded: MobileWebProviderReviewResult
  commentIds: Map<number, string>
}): Promise<unknown> {
  const { client, workspaceId, method, params, loaded, commentIds } = args
  const review = loaded.review
  if (!review || review.provider !== 'github') {
    throw new Error('unsupported_operation')
  }
  if (!isSlugCommentMutation(method) && review.number !== reviewNumber(params)) {
    throw new Error('conflict')
  }
  const identity = {
    workspaceId,
    expectedHead: loaded.observedHead,
    expectedBranch: loaded.branch,
    provider: review.provider,
    reviewNumber: review.number
  } as const
  if (method === 'github.addIssueComment') {
    await client.providerMutateReview({
      ...identity,
      action: 'comment',
      body: requiredString(params.body)
    })
    return { ok: true }
  }
  if (method === 'github.addPRReviewCommentReply') {
    const commentId = mappedCommentId(commentIds, params.commentId)
    await client.providerMutateReview({
      ...identity,
      action: 'reply',
      commentId,
      threadId: requiredString(params.threadId),
      body: requiredString(params.body)
    })
    return { ok: true }
  }
  if (method === 'github.resolveReviewThread') {
    await client.providerMutateReview({
      ...identity,
      action: 'setThreadResolved',
      threadId: requiredString(params.threadId),
      resolved: params.resolve === true
    })
    return true
  }
  const management = managementPayload(method, params, identity, commentIds, review)
  await client.providerManageReview(management)
  return method === 'github.updatePRTitle' ? true : { ok: true }
}

function managementPayload(
  method: string,
  params: RequestParams,
  identity: {
    workspaceId: string
    expectedHead: string
    expectedBranch: string
    provider: 'github'
    reviewNumber: number
  },
  commentIds: Map<number, string>,
  review: MobileWebProviderReview
): Parameters<MobileWebBridgeClient['providerManageReview']>[0] {
  if (method === 'github.mergePR') {
    return { ...identity, action: 'merge', ...optionalMergeMethod(params.method) }
  }
  if (method === 'github.setPRAutoMerge') {
    return {
      ...identity,
      action: 'setAutoMerge',
      enabled: requiredBoolean(params.enabled),
      ...optionalMergeMethod(params.method)
    }
  }
  if (method === 'github.updatePRState') {
    const updates = requiredRecord(params.updates)
    return { ...identity, action: 'setState', state: requiredReviewState(updates.state) }
  }
  if (method === 'github.requestPRReviewers' || method === 'github.removePRReviewers') {
    return {
      ...identity,
      action: method === 'github.requestPRReviewers' ? 'requestReviewers' : 'removeReviewers',
      reviewers: requiredReviewers(params.reviewers)
    }
  }
  if (method === 'github.rerunPRChecks') {
    return {
      ...identity,
      action: 'rerunChecks',
      ...(review.headSha ? { expectedReviewHead: review.headSha } : {}),
      ...(params.failedOnly === undefined ? {} : { failedOnly: requiredBoolean(params.failedOnly) })
    }
  }
  if (method === 'github.updatePRTitle') {
    return { ...identity, action: 'updateTitle', title: requiredString(params.title) }
  }
  const commentId = mappedCommentId(commentIds, params.commentId)
  return method === 'github.project.updateIssueCommentBySlug'
    ? {
        ...identity,
        action: 'updateConversationComment',
        commentId,
        body: requiredString(params.body)
      }
    : { ...identity, action: 'deleteConversationComment', commentId }
}

function mappedCommentId(commentIds: Map<number, string>, value: unknown): string {
  const id = commentIds.get(requiredNumber(value))
  if (!id) {
    throw new Error('conflict')
  }
  return id
}

function optionalMergeMethod(value: unknown): { method?: 'merge' | 'squash' | 'rebase' } {
  if (value === undefined) {
    return {}
  }
  if (value !== 'merge' && value !== 'squash' && value !== 'rebase') {
    throw new Error('invalid_request')
  }
  return { method: value }
}

function requiredReviewState(value: unknown): 'open' | 'closed' {
  if (value !== 'open' && value !== 'closed') {
    throw new Error('invalid_request')
  }
  return value
}

function requiredReviewers(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
  ) {
    throw new Error('invalid_request')
  }
  return value.map((entry) => String(entry).trim())
}

function reviewNumber(params: RequestParams): number | null {
  const value = params.prNumber ?? params.number
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('invalid_request')
  }
  return value.trim()
}

function requiredNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('invalid_request')
  }
  return value
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('invalid_request')
  }
  return value
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_request')
  }
  return value as Record<string, unknown>
}

function isSlugCommentMutation(method: string): boolean {
  return (
    method === 'github.project.updateIssueCommentBySlug' ||
    method === 'github.project.deleteIssueCommentBySlug'
  )
}
