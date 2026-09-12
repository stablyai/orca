import type { JiraComment, JiraIssue } from '../../../src/shared/jira-types'

export type JiraDetailComment = {
  id: string
  author?: string
  authorAvatarUrl?: string
  body: string
  createdAt?: string
}

type JiraIssueReadEnvelope = {
  items?: unknown
  issues?: unknown
}

// Mirrors extractLinearIssueReadItems: the runtime returns a bare array today,
// but older and streaming-wrapped hosts hand back an envelope instead.
export function extractJiraIssueReadItems(result: unknown): JiraIssue[] {
  if (Array.isArray(result)) {
    return result as JiraIssue[]
  }

  if (result && typeof result === 'object') {
    const envelope = result as JiraIssueReadEnvelope
    if (Array.isArray(envelope.items)) {
      return envelope.items as JiraIssue[]
    }
    if (Array.isArray(envelope.issues)) {
      return envelope.issues as JiraIssue[]
    }
  }

  throw new Error('Unexpected Jira tasks response')
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
