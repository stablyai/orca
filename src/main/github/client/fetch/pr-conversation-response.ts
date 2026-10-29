import { z } from 'zod'
import type { PRComment } from '../../../../shared/github/comment-types'
import { mapGraphQLReactionGroups } from '../../comment-reactions'

const commentSchema = z.object({
  id: z.string(),
  databaseId: z.number().nullable(),
  author: z
    .object({ __typename: z.string().optional(), login: z.string(), avatarUrl: z.string() })
    .nullable(),
  body: z.string().nullish(),
  createdAt: z.string(),
  submittedAt: z.string().nullish(),
  url: z.string(),
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
const commentConnection = z.object({ nodes: z.array(commentSchema.nullable()) })
const threadConnection = z.object({
  nodes: z.array(
    z
      .object({
        id: z.string(),
        isResolved: z.boolean(),
        line: z.number().nullable(),
        startLine: z.number().nullable(),
        originalLine: z.number().nullable(),
        originalStartLine: z.number().nullable(),
        comments: z.object({
          nodes: z.array(commentSchema.extend({ path: z.string() }).nullable())
        })
      })
      .nullable()
  )
})
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
  return {
    id: comment.databaseId,
    author: comment.author?.login ?? 'ghost',
    authorAvatarUrl: comment.author?.avatarUrl ?? '',
    body: comment.body ?? '',
    createdAt: comment.submittedAt ?? comment.createdAt,
    url: comment.url,
    isBot: comment.author?.__typename === 'Bot',
    reactionSubjectId: comment.id,
    reactions: mapGraphQLReactionGroups(comment.reactionGroups)
  }
}

export function parsePRConversationResponse(stdout: string): {
  issueComments?: PRComment[]
  reviewSummaries?: PRComment[]
  reviewComments: PRComment[]
} {
  const envelope = envelopeSchema.parse(JSON.parse(stdout))
  const pr = envelope.data?.repository?.pullRequest
  const failed = (source: string): boolean =>
    Boolean(
      envelope.errors?.some(
        (error) =>
          !error.path?.length || !error.path.includes('pullRequest') || error.path[2] === source
      )
    )
  const comments = commentConnection.safeParse(pr?.comments)
  const reviews = commentConnection.safeParse(pr?.reviews)
  const threads = threadConnection.safeParse(pr?.reviewThreads)
  return {
    issueComments:
      comments.success && !failed('comments')
        ? comments.data.nodes.filter(hasDatabaseId).map(mapGraphQLComment)
        : undefined,
    reviewSummaries:
      reviews.success && !failed('reviews')
        ? reviews.data.nodes
            .filter(hasDatabaseId)
            .filter((c) => c.body?.trim())
            .map(mapGraphQLComment)
        : undefined,
    reviewComments: threads.success
      ? threads.data.nodes.flatMap((thread) =>
          thread
            ? thread.comments.nodes.filter(hasDatabaseId).map((c) => ({
                ...mapGraphQLComment(c),
                path: c.path,
                threadId: thread.id,
                isResolved: thread.isResolved,
                isOutdated: thread.line == null,
                line: thread.line ?? thread.originalLine ?? undefined,
                startLine: thread.startLine ?? thread.originalStartLine ?? undefined
              }))
            : []
        )
      : []
  }
}

const restCommentSchema = z.object({
  id: z.number(),
  user: z
    .object({ login: z.string(), avatar_url: z.string(), type: z.string().optional() })
    .nullable(),
  body: z.string().nullish(),
  created_at: z.string().optional(),
  submitted_at: z.string().nullish(),
  html_url: z.string()
})

export function parseRestPRComments(stdout: string, reviews: boolean): PRComment[] {
  return z
    .array(restCommentSchema)
    .parse(JSON.parse(stdout))
    .filter((c) => !reviews || c.body?.trim())
    .map((c) => ({
      id: c.id,
      author: c.user?.login ?? 'ghost',
      authorAvatarUrl: c.user?.avatar_url ?? '',
      body: c.body ?? '',
      createdAt: (reviews ? c.submitted_at : c.created_at) ?? '',
      url: c.html_url,
      isBot: c.user?.type === 'Bot'
    }))
}
