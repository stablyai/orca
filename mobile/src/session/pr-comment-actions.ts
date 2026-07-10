import type { PRComment, PRState } from '../../../src/shared/types'

// Pure helpers for the interactive PR comment timeline (reply / resolve / add
// root comment). Kept free of React/native imports so they unit-test under the
// node Vitest config, mirroring the other mobile PR sidebar state modules.

// A review thread can be resolved/unresolved only when GitHub gave it a thread
// node id — plain conversation (issue) comments have no thread to toggle. Desktop
// gates the resolve control the same way.
export function isResolvableComment(comment: Pick<PRComment, 'threadId'>): boolean {
  return typeof comment.threadId === 'string' && comment.threadId.length > 0
}

// Root-comment composer is offered only on an OPEN PR — a closed/merged PR is no
// longer an active conversation surface (desktop parity).
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

// Build the github.addPRReviewCommentReply payload from the comment being replied
// to. threadId/path/line are forwarded only when present so the host schema (which
// marks them optional) never receives empty strings.
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

// Toggle: resolve when currently unresolved, unresolve when resolved. The host's
// github.resolveReviewThread takes a `resolve` boolean and runs the matching
// GraphQL mutation, so one wrapper covers both directions.
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

// Edit/delete are offered only on root conversation (issue) comments — the host
// only exposes update/deleteIssueComment, and inline review comments / replies
// (which carry a threadId or path, or live under a pullrequestreview URL) are not
// editable. Mirrors desktop's isMutablePRConversationComment gating; GitHub itself
// enforces authorship, so there is no client-side viewer-identity check.
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

// Edit/delete need the repo slug (the host RPCs are slug-addressed, not worktree-
// addressed) plus a mutable comment. Returns null when either is missing so the UI
// can hide the affordance rather than firing a doomed request.
export function canEditComment(
  comment: Pick<PRComment, 'id' | 'threadId' | 'path' | 'url'>,
  prRepo: { owner: string; repo: string } | null | undefined
): boolean {
  return Boolean(prRepo) && isMutablePRConversationComment(comment)
}

export function canDeleteComment(
  comment: Pick<PRComment, 'id' | 'threadId' | 'path' | 'url'>,
  prRepo: { owner: string; repo: string } | null | undefined
): boolean {
  return Boolean(prRepo) && isMutablePRConversationComment(comment)
}

export type EditCommentParams = { owner: string; repo: string; commentId: number; body: string }

export function buildEditCommentParams(
  prRepo: { owner: string; repo: string },
  commentId: number,
  body: string
): EditCommentParams {
  return { owner: prRepo.owner, repo: prRepo.repo, commentId, body }
}

export type DeleteCommentParams = { owner: string; repo: string; commentId: number }

export function buildDeleteCommentParams(
  prRepo: { owner: string; repo: string },
  commentId: number
): DeleteCommentParams {
  return { owner: prRepo.owner, repo: prRepo.repo, commentId }
}

// The composer disables submit on empty/whitespace input (host rejects empty body).
export function isSubmittableCommentBody(body: string): boolean {
  return body.trim().length > 0
}
