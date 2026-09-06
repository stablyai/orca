import {
  MOBILE_WEB_PROVIDER_REVIEW_BODY_MAX_CHARACTERS,
  MOBILE_WEB_PROVIDER_REVIEW_COMMENT_MAX_CHARACTERS,
  MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT,
  MobileWebProviderReviewCommentSchema,
  MobileWebProviderReviewSchema,
  type MobileWebProviderReview,
  type MobileWebProviderReviewComment,
  type MobileWebProviderReviewProvider
} from '../../../src/shared/mobile-web/provider-review-contract'
import {
  sanitizeMobileWebProviderReviewFiles,
  sanitizedProviderReviewHead
} from './mobile-web-provider-review-files'
import {
  sanitizeMobileWebProviderReviewChecks,
  sanitizeMobileWebProviderReviewSummaries,
  sanitizeMobileWebProviderReviewUsers
} from './mobile-web-provider-review-participants'

type ReviewSummary = Omit<
  MobileWebProviderReview,
  | 'body'
  | 'comments'
  | 'commentsTruncated'
  | 'files'
  | 'filesTruncated'
  | 'author'
  | 'reviewRequests'
  | 'latestReviews'
  | 'checks'
  | 'detailsState'
  | 'canComment'
  | 'allowedSubmissionActions'
>

export function sanitizeMobileWebProviderReviewSummary(value: unknown): ReviewSummary | null {
  if (!isRecord(value)) {
    return null
  }
  const provider = reviewProvider(value.provider)
  const number = positiveInteger(value.number)
  if (!provider || number === null) {
    return null
  }
  const headSha = boundedHead(value.headSha)
  return {
    provider,
    number,
    title: boundedString(value.title, 512),
    state: reviewState(value.state),
    checksStatus: checksStatus(value.status),
    mergeable: mergeableState(value.mergeable),
    reviewDecision: reviewDecision(value.reviewDecision),
    ...(typeof value.autoMergeEnabled === 'boolean'
      ? { autoMergeEnabled: value.autoMergeEnabled }
      : {}),
    ...(typeof value.autoMergeAllowed === 'boolean' || value.autoMergeAllowed === null
      ? { autoMergeAllowed: value.autoMergeAllowed }
      : {}),
    ...(typeof value.mergeStateStatus === 'string' || value.mergeStateStatus === null
      ? { mergeStateStatus: value.mergeStateStatus }
      : {}),
    updatedAt: boundedString(value.updatedAt, 64),
    ...(headSha ? { headSha } : {})
  }
}

export function sanitizeMobileWebProviderReviewDetails(
  summary: ReviewSummary,
  details: unknown
): MobileWebProviderReview {
  if (summary.provider !== 'github' && summary.provider !== 'gitlab') {
    return MobileWebProviderReviewSchema.parse({
      ...summary,
      body: '',
      comments: [],
      commentsTruncated: false,
      files: [],
      filesTruncated: false,
      author: null,
      reviewRequests: [],
      latestReviews: [],
      checks: [],
      detailsState: 'unsupported',
      canComment: false,
      allowedSubmissionActions: []
    })
  }
  if (
    !isRecord(details) ||
    !isRecord(details.item) ||
    positiveInteger(details.item.number) !== summary.number ||
    details.item.type !== (summary.provider === 'github' ? 'pr' : 'mr')
  ) {
    return MobileWebProviderReviewSchema.parse({
      ...summary,
      body: '',
      comments: [],
      commentsTruncated: false,
      files: [],
      filesTruncated: false,
      author: null,
      reviewRequests: [],
      latestReviews: [],
      checks: [],
      detailsState: 'unavailable',
      canComment: false,
      allowedSubmissionActions: []
    })
  }
  const comments = sanitizeComments(summary.provider, details.comments)
  const files = sanitizeMobileWebProviderReviewFiles(summary.provider, details.files)
  const headSha = sanitizedProviderReviewHead(details) ?? summary.headSha
  return MobileWebProviderReviewSchema.parse({
    ...summary,
    ...(headSha ? { headSha } : {}),
    body: boundedString(details.body, MOBILE_WEB_PROVIDER_REVIEW_BODY_MAX_CHARACTERS),
    comments: comments.items,
    commentsTruncated: comments.truncated,
    files: files.items,
    filesTruncated: files.truncated,
    author: nonemptyBoundedString(details.item.author, 80) ?? null,
    reviewRequests: sanitizeMobileWebProviderReviewUsers(details.item.reviewRequests),
    latestReviews: sanitizeMobileWebProviderReviewSummaries(details.item.latestReviews),
    checks: sanitizeMobileWebProviderReviewChecks(details.checks),
    detailsState: 'loaded',
    canComment: true,
    allowedSubmissionActions: providerSubmissionActions(summary, headSha)
  })
}

function providerSubmissionActions(
  review: ReviewSummary,
  headSha: string | undefined
): MobileWebProviderReview['allowedSubmissionActions'] {
  if ((review.state !== 'open' && review.state !== 'draft') || !headSha) {
    return []
  }
  return review.provider === 'github'
    ? ['comment', 'approve', 'request-changes']
    : review.provider === 'gitlab'
      ? ['comment']
      : []
}

function sanitizeComments(
  provider: MobileWebProviderReviewProvider,
  value: unknown
): {
  items: MobileWebProviderReviewComment[]
  truncated: boolean
} {
  if (!Array.isArray(value)) {
    return { items: [], truncated: false }
  }
  const parsed = value.flatMap((entry): MobileWebProviderReviewComment[] => {
    const comment = sanitizeComment(provider, entry)
    return comment ? [comment] : []
  })
  return {
    items: parsed.slice(-MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT),
    truncated: parsed.length > MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT
  }
}

function sanitizeComment(
  provider: MobileWebProviderReviewProvider,
  value: unknown
): MobileWebProviderReviewComment | null {
  if (!isRecord(value)) {
    return null
  }
  const id = identifier(value.id)
  if (!id) {
    return null
  }
  const path = safeRelativePath(value.path)
  const line = positiveInteger(value.line)
  const startLine = positiveInteger(value.startLine)
  const threadId = nonemptyBoundedString(value.threadId, 256)
  const allowedActions = providerCommentActions(provider, id, threadId)
  const kind = path || line !== null || threadId ? 'inline' : 'conversation'
  const parsed = MobileWebProviderReviewCommentSchema.safeParse({
    id,
    author: boundedString(value.author, 160),
    body: boundedString(value.body, MOBILE_WEB_PROVIDER_REVIEW_COMMENT_MAX_CHARACTERS),
    createdAt: boundedString(value.createdAt, 64),
    kind,
    ...(path ? { path } : {}),
    ...(line !== null ? { line } : {}),
    ...(startLine !== null ? { startLine } : {}),
    ...(threadId ? { threadId } : {}),
    ...(threadId ? { threadState: commentThreadState(value) } : {}),
    allowedActions,
    ...(typeof value.isBot === 'boolean' ? { isBot: value.isBot } : {})
  })
  return parsed.success ? parsed.data : null
}

function providerCommentActions(
  provider: MobileWebProviderReviewProvider,
  commentId: string,
  threadId: string | undefined
): MobileWebProviderReviewComment['allowedActions'] {
  if (!threadId) {
    return []
  }
  const actions: MobileWebProviderReviewComment['allowedActions'] = []
  if (provider === 'github' && positiveIntegerString(commentId) !== null) {
    actions.push('reply')
  }
  if (provider === 'github' || provider === 'gitlab') {
    actions.push('set-resolved')
  }
  return actions
}

function reviewProvider(value: unknown): MobileWebProviderReviewProvider | null {
  return value === 'github' ||
    value === 'gitlab' ||
    value === 'bitbucket' ||
    value === 'azure-devops' ||
    value === 'gitea'
    ? value
    : null
}

function reviewState(value: unknown): MobileWebProviderReview['state'] {
  return value === 'closed' || value === 'merged' || value === 'draft' ? value : 'open'
}

function checksStatus(value: unknown): MobileWebProviderReview['checksStatus'] {
  return value === 'success' || value === 'failure' || value === 'pending' ? value : 'neutral'
}

function mergeableState(value: unknown): MobileWebProviderReview['mergeable'] {
  return value === 'MERGEABLE' || value === 'CONFLICTING' ? value : 'UNKNOWN'
}

function reviewDecision(value: unknown): MobileWebProviderReview['reviewDecision'] {
  return value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED'
    ? value
    : null
}

function commentThreadState(
  value: Record<string, unknown>
): NonNullable<MobileWebProviderReviewComment['threadState']> {
  if (value.isOutdated === true) {
    return 'outdated'
  }
  return value.isResolved === true ? 'resolved' : 'open'
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    return undefined
  }
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return undefined
  }
  return value.split('/').every((part) => part && part !== '.' && part !== '..') ? value : undefined
}

function boundedHead(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
    ? value
    : undefined
}

function boundedString(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function nonemptyBoundedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined
}

function identifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value)
  }
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : null
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
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
