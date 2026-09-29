import { z } from 'zod'
import type { LinearAttentionRequest, LinearInboxPage } from '../../shared/linear/attention-types'
import { readWithVerifiedLinearViewer } from './linear-personal-read'
import { acquire, release } from './linear-request-concurrency'
import { readAttentionCursor, saveAttentionCursor } from './linear-attention-cursors'

const INBOX_QUERY = `query OrcaPersonalInbox($first: Int!, $after: String) {
  notifications(first: $first, after: $after) {
    nodes {
      __typename id type title subtitle url readAt snoozedUntilAt updatedAt user { id }
      ... on IssueNotification { issue { id identifier title url } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`
const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string()
})
const inboxSchema = z.object({
  notifications: z.object({
    nodes: z
      .array(
        z.object({
          __typename: z.string(),
          id: z.string(),
          type: z.string(),
          title: z.string(),
          subtitle: z.string(),
          url: z.string(),
          readAt: z.string().nullable(),
          snoozedUntilAt: z.string().nullable(),
          updatedAt: z.string(),
          user: z.object({ id: z.string() }),
          issue: issueSchema.nullish()
        })
      )
      .max(50),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
  })
})

export async function readLinearInbox(args: LinearAttentionRequest): Promise<LinearInboxPage> {
  await acquire()
  try {
    const result = await readWithVerifiedLinearViewer(args.workspaceId, async (client, scope) => {
      const namespace = JSON.stringify(['inbox', scope])
      const after = readAttentionCursor(args.cursor, namespace)
      const response = await client.client.rawRequest<unknown, { first: number; after?: string }>(
        INBOX_QUERY,
        { first: 50, after }
      )
      if (response.errors?.length) {
        throw new Error('Linear returned an incomplete Inbox response.')
      }
      const { notifications } = inboxSchema.parse(response.data)
      if (notifications.nodes.some((node) => node.user.id !== scope.viewerId)) {
        throw new Error('Linear returned notifications for a different viewer. Reconnect Linear.')
      }
      return {
        items: notifications.nodes.map((node) => ({
          id: node.id,
          kind: node.__typename,
          type: node.type,
          title: node.title,
          subtitle: node.subtitle,
          url: node.url,
          readAt: node.readAt,
          snoozedUntilAt: node.snoozedUntilAt,
          updatedAt: node.updatedAt,
          issue: node.__typename === 'IssueNotification' ? (node.issue ?? null) : null
        })),
        nextCursor: saveAttentionCursor(namespace, notifications.pageInfo, after)
      }
    })
    return { scope: result.scope, ...result.data }
  } finally {
    release()
  }
}
