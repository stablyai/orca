// A doc's open comments, as `orca docs read` shows them: each clipped, and only as many as fit
// beside a full page of text.
import { z } from 'zod'
import type { DocsComment } from '../../shared/google/google-files-types'
import { parseGoogleJson, type GoogleApi } from './google-api-client'
import { allDrives, DRIVE } from './google-drive-files'

// Comments ride on a doc's first page, beside a full page of text, so they get a small budget.
const COMMENTS_BUDGET_CHARS = 3_000
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

const CommentsSchema = z.object({
  comments: z
    .array(
      z.object({
        content: z.string().default(''),
        resolved: z.boolean().optional(),
        deleted: z.boolean().optional(),
        author: z.object({ displayName: z.string().optional() }).optional(),
        quotedFileContent: z.object({ value: z.string().optional() }).optional(),
        replies: z
          .array(
            z.object({
              content: z.string().default(''),
              deleted: z.boolean().optional(),
              author: z.object({ displayName: z.string().optional() }).optional()
            })
          )
          .default([])
      })
    )
    .default([])
})

export async function openComments(api: GoogleApi, id: string): Promise<DocsComment[]> {
  const url = allDrives(new URL(`${DRIVE}/files/${encodeURIComponent(id)}/comments`))
  url.searchParams.set(
    'fields',
    'comments(content,resolved,deleted,author(displayName),quotedFileContent(value),replies(content,deleted,author(displayName)))'
  )
  url.searchParams.set('pageSize', '100')
  const answer = await api.get('drive', url.toString(), parseGoogleJson(CommentsSchema))
  return answer.comments
    .filter((comment) => !comment.resolved && !comment.deleted)
    .map((comment) => ({
      author: clip(comment.author?.displayName ?? 'someone', 80),
      text: clip(comment.content, 500),
      ...(comment.quotedFileContent?.value
        ? { quote: clip(comment.quotedFileContent.value, 200) }
        : {}),
      replies: comment.replies
        .filter((reply) => !reply.deleted && reply.content)
        .slice(-3)
        .map((reply) => ({
          author: clip(reply.author?.displayName ?? 'someone', 80),
          text: clip(reply.content, 300)
        }))
    }))
}

/** The comments that fit the first page's budget, oldest first. */
export function commentsInBudget(comments: DocsComment[]): DocsComment[] {
  let used = 0
  const shown: DocsComment[] = []
  for (const comment of comments) {
    used += JSON.stringify(comment).length
    if (used > COMMENTS_BUDGET_CHARS) {
      break
    }
    shown.push(comment)
  }
  return shown
}
