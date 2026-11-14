import { githubBodyImageUrls, removeFailedGitHubBodyHtml } from '../../attachments/body-image-urls'
import type { Nodes } from 'mdast'
import { z } from 'zod'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { PRComment, PRReviewVerdict } from '../../../../shared/github/comments/comment-types'
import { mapGraphQLReactionGroups } from '../../comments/comment-reactions'
import { tailDiffHunk } from '../../../../shared/github/comments/pr-comment-diff-hunk'
import { viewerAuthorship } from '../../../source-control/comment-viewer-authorship'

const commentSchema = z.object({
  id: z.string(),
  databaseId: z.number().nullable(),
  author: z
    .object({ __typename: z.string().optional(), login: z.string(), avatarUrl: z.string() })
    .nullable(),
  body: z.string().nullish(),
  bodyHTML: z.unknown().optional(),
  createdAt: z.string(),
  submittedAt: z.string().nullish(),
  state: z.string().nullish(),
  url: z.string(),
  viewerDidAuthor: z.boolean().nullish().catch(undefined),
  reactionGroups: z
    .array(
      z.object({
        content: z.string().nullish(),
        viewerHasReacted: z.boolean().nullish(),
        reactors: z.object({ totalCount: z.number().nullish() }).nullish()
      })
    )
    .nullish()
})
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }).optional()
const commentConnection = z.object({ nodes: z.array(commentSchema.nullable()), pageInfo })
const threadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  line: z.number().nullable(),
  startLine: z.number().nullable(),
  originalLine: z.number().nullable(),
  originalStartLine: z.number().nullable(),
  diffSide: z.string().nullish().catch(undefined),
  rootHunk: z
    .object({ nodes: z.array(z.object({ diffHunk: z.string().nullish() }).nullable()) })
    .nullish()
    .catch(undefined),
  comments: z.object({
    nodes: z.array(commentSchema.extend({ path: z.string() }).nullable()),
    pageInfo
  })
})
const threadConnection = z.object({ nodes: z.array(threadSchema.nullable()), pageInfo })
export type PRConversationSources = {
  comments?: z.infer<typeof commentConnection>
  reviews?: z.infer<typeof commentConnection>
  reviewThreads?: z.infer<typeof threadConnection>
}
export type PRReviewThread = z.infer<typeof threadSchema>
const envelopeSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              comments: z.unknown().optional(),
              reviews: z.unknown().optional(),
              reviewThreads: z.unknown().optional()
            })
            .nullish()
        })
        .nullish()
    })
    .nullish(),
  errors: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])).optional() }))
    .optional()
})

function hasDatabaseId<T extends { databaseId: number | null }>(
  comment: T | null
): comment is T & { databaseId: number } {
  return typeof comment?.databaseId === 'number'
}

function mapGraphQLComment(
  comment: z.infer<typeof commentSchema> & { databaseId: number }
): PRComment {
  const mapped: PRComment = {
    id: comment.databaseId,
    author: comment.author?.login ?? 'ghost',
    authorAvatarUrl: comment.author?.avatarUrl ?? '',
    body: comment.body ?? '',
    bodyImageUrls: githubBodyImageUrls(comment.body, comment.bodyHTML),
    createdAt: comment.submittedAt ?? comment.createdAt,
    url: comment.url,
    isBot: comment.author?.__typename === 'Bot',
    ...(comment.viewerDidAuthor === true ? { viewerDidAuthor: true } : {}),
    reactionSubjectId: comment.id,
    reactions: mapGraphQLReactionGroups(comment.reactionGroups)
  }
  return mapped
}

const reviewMarkdown = unified().use(remarkParse)

function hasVisibleReviewBody(body: string | null | undefined): boolean {
  if (!body?.trim()) {
    return false
  }
  if (!body.includes('<!--')) {
    return true
  }
  const hasVisibleNode = (node: Nodes): boolean => {
    if ('children' in node) {
      return node.children.some(hasVisibleNode)
    }
    if (node.type === 'html') {
      return Boolean(node.value.replace(/<!--[\s\S]*?-->/g, '').trim())
    }
    return node.type !== 'text' || Boolean(node.value.trim())
  }
  return reviewMarkdown.parse(body).children.some(hasVisibleNode)
}

function reviewVerdict(state: string | null | undefined): PRReviewVerdict | undefined {
  return state === 'APPROVED' || state === 'CHANGES_REQUESTED' ? state : undefined
}

function isVisibleReview(review: { body?: string | null; state?: string | null }): boolean {
  return Boolean(reviewVerdict(review.state)) || hasVisibleReviewBody(review.body)
}

// A review kept only for its verdict drops its metadata-only body so every surface sees it as empty.
function reviewStateFields(review: { body?: string | null; state?: string | null }): {
  reviewState?: PRReviewVerdict
  body?: string
} {
  const verdict = reviewVerdict(review.state)
  if (!verdict) {
    return {}
  }
  return hasVisibleReviewBody(review.body)
    ? { reviewState: verdict }
    : { reviewState: verdict, body: '' }
}

export function parsePRConversationSources(
  stdout: string,
  strictSource?: string
): PRConversationSources {
  const envelope = envelopeSchema.parse(JSON.parse(stdout))
  const errors = removeFailedGitHubBodyHtml(envelope.data, envelope.errors)
  const pr = envelope.data?.repository?.pullRequest
  const failed = (source: string): boolean =>
    Boolean(
      errors?.some(
        (error) =>
          !error.path?.length || !error.path.includes('pullRequest') || error.path[2] === source
      )
    )
  if (strictSource && failed(strictSource)) {
    throw new Error('Incomplete GitHub conversation source')
  }
  const comments = commentConnection.safeParse(pr?.comments)
  const reviews = commentConnection.safeParse(pr?.reviews)
  const threads = threadConnection.safeParse(pr?.reviewThreads)
  return {
    ...(comments.success && !failed('comments') ? { comments: comments.data } : {}),
    ...(reviews.success && !failed('reviews') ? { reviews: reviews.data } : {}),
    ...(threads.success ? { reviewThreads: threads.data } : {})
  }
}

export function parsePRReviewThreadResponse(stdout: string): PRReviewThread {
  const envelope = z
    .object({ data: z.object({ node: z.unknown() }), errors: envelopeSchema.shape.errors })
    .parse(JSON.parse(stdout))
  const errors = removeFailedGitHubBodyHtml(envelope.data, envelope.errors)
  if (errors?.length) {
    throw new Error('Incomplete GitHub review thread replies')
  }
  return threadSchema.parse(envelope.data.node)
}

export function parsePRConversationResponse(stdout: string): {
  issueComments?: PRComment[]
  reviewSummaries?: PRComment[]
  reviewComments: PRComment[]
} {
  return mapPRConversationSources(parsePRConversationSources(stdout))
}

export function mapPRConversationSources(sources: PRConversationSources): {
  issueComments?: PRComment[]
  reviewSummaries?: PRComment[]
  reviewComments: PRComment[]
} {
  const { comments, reviews, reviewThreads: threads } = sources
  return {
    issueComments: comments
      ? comments.nodes.filter(hasDatabaseId).map(mapGraphQLComment)
      : undefined,
    reviewSummaries: reviews
      ? reviews.nodes
          .filter(hasDatabaseId)
          .filter(isVisibleReview)
          .map((c) => ({ ...mapGraphQLComment(c), ...reviewStateFields(c) }))
      : undefined,
    reviewComments: threads
      ? threads.nodes.flatMap((thread) =>
          thread
            ? thread.comments.nodes.filter(hasDatabaseId).map((c) =>
                Object.assign(mapGraphQLComment(c), {
                  // Left-side threads count old-file lines, which the shared tail numbering cannot place.
                  ...(c === thread.comments.nodes[0] && thread.diffSide !== 'LEFT'
                    ? rootDiffHunk(thread.rootHunk)
                    : {}),
                  path: c.path,
                  threadId: thread.id,
                  isResolved: thread.isResolved,
                  isOutdated: thread.line == null,
                  line: thread.line ?? thread.originalLine ?? undefined,
                  startLine: thread.startLine ?? thread.originalStartLine ?? undefined
                })
              )
            : []
        )
      : []
  }
}

function rootDiffHunk(
  rootHunk: { nodes: ({ diffHunk?: string | null } | null)[] } | null | undefined
): { diffHunk?: string } {
  const diffHunk = tailDiffHunk(rootHunk?.nodes[0]?.diffHunk)
  return diffHunk ? { diffHunk } : {}
}

const restCommentSchema = z.object({
  id: z.number(),
  user: z
    .object({ login: z.string(), avatar_url: z.string(), type: z.string().optional() })
    .nullable(),
  body: z.string().nullish(),
  body_html: z.unknown().optional(),
  created_at: z.string().optional(),
  submitted_at: z.string().nullish(),
  state: z.string().nullish(),
  html_url: z.string()
})

export function parseRestPRCommentPage(
  stdout: string,
  reviews: boolean,
  viewerLogin: string | null
): { comments: PRComment[]; rawIds: number[]; hasMore: boolean } {
  const rows = z.array(restCommentSchema).parse(JSON.parse(stdout))
  const comments = rows
    .filter((c) => !reviews || isVisibleReview(c))
    .map((c) => ({
      id: c.id,
      author: c.user?.login ?? 'ghost',
      authorAvatarUrl: c.user?.avatar_url ?? '',
      body: c.body ?? '',
      bodyImageUrls: githubBodyImageUrls(c.body, c.body_html),
      createdAt: (reviews ? c.submitted_at : c.created_at) ?? '',
      url: c.html_url,
      isBot: c.user?.type === 'Bot',
      ...viewerAuthorship(c.user?.login, viewerLogin),
      ...(reviews ? reviewStateFields(c) : {})
    }))
  return { comments, rawIds: rows.map((row) => row.id), hasMore: rows.length >= 100 }
}

export function parseRestPRComments(
  stdout: string,
  reviews: boolean,
  viewerLogin: string | null
): PRComment[] {
  return parseRestPRCommentPage(stdout, reviews, viewerLogin).comments
}
