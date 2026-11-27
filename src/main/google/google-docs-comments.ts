// A doc's open comments, as `orca docs read` shows them: each clipped, and only as many as fit
// beside a full page of text.
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import type { DocsComment } from '../../shared/google/google-files-types'
import { parseGoogleJson, type GoogleApi } from './google-api-client'
import { allDrives, DRIVE } from './google-drive-files'

// Comments ride on a doc's first page, beside a full page of text, so they get a small budget.
const COMMENTS_BUDGET_CHARS = 3_000
// Drive lists resolved comments too; past this many pages the count is only a lower bound.
const MAX_COMMENT_PAGES = 20
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

const CommentsSchema = lazyZodSchema(() =>
  z.object({
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
      .default([]),
    nextPageToken: z.string().optional()
  })
)

/** `more` when the doc has comment pages that were not read: past `maxPages`, or after a later page failed. */
export async function openComments(
  api: GoogleApi,
  id: string,
  maxPages = MAX_COMMENT_PAGES
): Promise<{ comments: DocsComment[]; more: boolean }> {
  const url = allDrives(new URL(`${DRIVE}/files/${encodeURIComponent(id)}/comments`))
  url.searchParams.set(
    'fields',
    'nextPageToken,comments(content,resolved,deleted,author(displayName),quotedFileContent(value),replies(content,deleted,author(displayName)))'
  )
  url.searchParams.set('pageSize', '100')
  const comments: DocsComment[] = []
  let pageToken: string | undefined
  for (let page = 0; page < maxPages; page++) {
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }
    const request = api.get('drive', url.toString(), parseGoogleJson(CommentsSchema))
    // Page 1 fails the read as before; a later page failing keeps what was read as a lower bound.
    const answer = page === 0 ? await request : await request.catch(() => null)
    if (!answer) {
      return { comments, more: true }
    }
    comments.push(
      ...answer.comments
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
    )
    pageToken = answer.nextPageToken
    if (!pageToken) {
      return { comments, more: false }
    }
  }
  return { comments, more: true }
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
