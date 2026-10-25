import type { PRComment } from '../../../src/shared/github/comment-types'
import type { GitHubOwnerRepo, PRState } from '../../../src/shared/github/pull-request-types'

// Only inline review threads have resolvable node ids; conversation comments cannot resolve.
export function isResolvableComment(comment: Pick<PRComment, 'threadId'>): boolean {
  return typeof comment.threadId === 'string' && comment.threadId.length > 0
}

export function canAddRootComment(state: PRState | null | undefined): boolean {
  return state === 'open' || state === 'draft'
}

export type ReplyParams = {
  prNumber: number
  commentId: number
  body: string
  threadId?: string
  path?: string
  line?: number
}

// Omit missing thread/path/line fields rather than sending empty optional values.
export function buildReplyParams(prNumber: number, comment: PRComment, body: string): ReplyParams {
  const params: ReplyParams = {
    prNumber,
    commentId: comment.id,
    body
  }
  if (comment.threadId) {
    params.threadId = comment.threadId
  }
  if (comment.path) {
    params.path = comment.path
  }
  if (typeof comment.line === 'number') {
    params.line = comment.line
  }
  return params
}

export type ResolveParams = { threadId: string; resolve: boolean }

export function buildResolveParams(comment: PRComment): ResolveParams | null {
  if (!comment.threadId) {
    return null
  }
  return { threadId: comment.threadId, resolve: comment.isResolved !== true }
}

export type AddRootCommentParams = { prNumber: number; body: string }

export function buildAddRootCommentParams(prNumber: number, body: string): AddRootCommentParams {
  return { prNumber, body }
}

// Host edit/delete supports only conversation comments; review comments/replies are immutable here, and GitHub enforces authorship.
export function isMutablePRConversationComment(
  comment: Pick<PRComment, 'id' | 'threadId' | 'path' | 'url'>
): boolean {
  if (comment.threadId || comment.path) {
    return false
  }
  if (comment.url && comment.url.includes('pullrequestreview')) {
    return false
  }
  return Number.isSafeInteger(comment.id) && comment.id > 0
}

// Hide mutation controls without a repo slug or mutable comment; these RPCs are slug-addressed.
export function canEditComment(
  comment: Pick<PRComment, 'id' | 'threadId' | 'path' | 'url'>,
  prRepo: GitHubOwnerRepo | null | undefined
): boolean {
  return Boolean(prRepo) && isMutablePRConversationComment(comment)
}

export function canDeleteComment(
  comment: Pick<PRComment, 'id' | 'threadId' | 'path' | 'url'>,
  prRepo: GitHubOwnerRepo | null | undefined
): boolean {
  return Boolean(prRepo) && isMutablePRConversationComment(comment)
}

export type EditCommentParams = GitHubOwnerRepo & { commentId: number; body: string }

export function buildEditCommentParams(
  prRepo: GitHubOwnerRepo,
  commentId: number,
  body: string
): EditCommentParams {
  return {
    owner: prRepo.owner,
    repo: prRepo.repo,
    ...(prRepo.host ? { host: prRepo.host } : {}),
    commentId,
    body
  }
}

export type DeleteCommentParams = GitHubOwnerRepo & { commentId: number }

export function buildDeleteCommentParams(
  prRepo: GitHubOwnerRepo,
  commentId: number
): DeleteCommentParams {
  return {
    owner: prRepo.owner,
    repo: prRepo.repo,
    ...(prRepo.host ? { host: prRepo.host } : {}),
    commentId
  }
}

export function isSubmittableCommentBody(body: string): boolean {
  return body.trim().length > 0
}
