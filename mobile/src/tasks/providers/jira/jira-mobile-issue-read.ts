import { jiraCommentListSchema } from './jira-reply-schema'

export type JiraDetailComment = {
  id: string
  author?: string
  authorAvatarUrl?: string
  body: string
  createdAt?: string
}

// Optional comments must not hide a readable issue.
export function toJiraDetailComments(result: unknown): JiraDetailComment[] {
  const decoded = jiraCommentListSchema.safeParse(result)
  if (!decoded.success) {
    return []
  }
  return decoded.data.map((comment) => ({
    id: comment.id,
    author: comment.user?.displayName,
    authorAvatarUrl: comment.user?.avatarUrl,
    body: comment.body ?? '',
    createdAt: comment.createdAt
  }))
}
