import type { JiraComment } from '../../../src/shared/jira-types'

export type JiraDetailComment = {
  id: string
  author?: string
  authorAvatarUrl?: string
  body: string
  createdAt?: string
}

// Comments are best-effort in the detail sheet: a failed or malformed response
// should leave the issue readable rather than blow up the whole payload.
export function toJiraDetailComments(result: unknown): JiraDetailComment[] {
  if (!Array.isArray(result)) {
    return []
  }
  return (result as JiraComment[])
    .filter((comment) => comment && typeof comment.id === 'string')
    .map((comment) => ({
      id: comment.id,
      author: comment.user?.displayName,
      authorAvatarUrl: comment.user?.avatarUrl,
      body: comment.body ?? '',
      createdAt: comment.createdAt
    }))
}
