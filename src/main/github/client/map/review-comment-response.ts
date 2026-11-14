import { githubBodyImageUrls } from '../../attachments/body-image-urls'
import type { PRComment } from '../../../../shared/github/comments/comment-types'
export function mapReviewCommentResponse(
  data: {
    id?: number
    node_id?: string | null
    user: { login: string; avatar_url: string; type?: string } | null
    body?: string
    body_html?: string | null
    created_at?: string
    html_url?: string
    path?: string
    line?: number | null
  },
  body: string,
  path?: string,
  line?: number,
  startLine?: number,
  threadId?: string
): PRComment {
  return {
    id: data.id ?? Date.now(),
    reactionSubjectId: data.node_id?.trim() || undefined,
    author: data.user?.login ?? 'You',
    authorAvatarUrl: data.user?.avatar_url ?? '',
    body: data.body ?? body,
    bodyImageUrls: githubBodyImageUrls(data.body ?? body, data.body_html),
    createdAt: data.created_at ?? new Date().toISOString(),
    url: data.html_url ?? '',
    isBot: data.user?.type === 'Bot',
    path: data.path ?? path,
    line: data.line ?? line,
    startLine,
    threadId
  }
}
