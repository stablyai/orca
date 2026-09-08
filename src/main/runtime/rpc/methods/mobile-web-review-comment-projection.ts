import {
  MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_COMMENT_MAX_CHARACTERS,
  type MobileWebProviderReview,
  type MobileWebProviderReviewProvider
} from '../../../../shared/mobile-web/provider-review-contract'

/** What both providers' comment types share. GitLab has no outdated-thread marker, which an
 *  optional field already covers. */
type ProviderReviewComment = {
  id: number
  author: string
  body: string
  createdAt: string
  path?: string
  threadId?: string
  isResolved?: boolean
  isOutdated?: boolean
  line?: number
  startLine?: number
  isBot?: boolean
}

export function projectMobileWebReviewComments(
  provider: MobileWebProviderReviewProvider,
  comments: readonly ProviderReviewComment[]
): { items: MobileWebProviderReview['comments']; truncated: boolean } {
  return {
    // The newest comments are the ones worth reading on a phone.
    items: comments
      .slice(-MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT)
      .map((comment) => projectComment(provider, comment)),
    truncated: comments.length > MOBILE_WEB_PROVIDER_REVIEW_COMMENT_LIMIT
  }
}

function projectComment(
  provider: MobileWebProviderReviewProvider,
  comment: ProviderReviewComment
): MobileWebProviderReview['comments'][number] {
  const inline = comment.path !== undefined || comment.line !== undefined || comment.threadId
  return {
    id: String(comment.id),
    author: comment.author.slice(0, 160),
    body: comment.body.slice(0, MOBILE_WEB_PROVIDER_REVIEW_COMMENT_MAX_CHARACTERS),
    createdAt: comment.createdAt.slice(0, 64),
    kind: inline ? 'inline' : 'conversation',
    ...(comment.path === undefined ? {} : { path: comment.path }),
    ...(comment.line === undefined ? {} : { line: comment.line }),
    ...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
    ...(comment.threadId === undefined
      ? {}
      : { threadId: comment.threadId, threadState: threadState(comment) }),
    allowedActions: commentActions(provider, comment.threadId),
    ...(comment.isBot === undefined ? {} : { isBot: comment.isBot })
  }
}

/** Only a threaded comment can be replied to or resolved. */
function commentActions(
  provider: MobileWebProviderReviewProvider,
  threadId: string | undefined
): MobileWebProviderReview['comments'][number]['allowedActions'] {
  if (threadId === undefined) {
    return []
  }
  return provider === 'github' ? ['reply', 'set-resolved'] : ['set-resolved']
}

function threadState(
  comment: ProviderReviewComment
): NonNullable<MobileWebProviderReview['comments'][number]['threadState']> {
  if (comment.isOutdated === true) {
    return 'outdated'
  }
  return comment.isResolved === true ? 'resolved' : 'open'
}
