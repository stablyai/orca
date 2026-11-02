import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { ConnectorConversation } from '@orca-cloud/connector-contract'
import type { ConnectorAdapter } from './connector-adapter.js'
import { conversationKey } from './connector-threads.js'

// Decisions §1 / 11: a teammate's message in someone else's conversation is kept for that owner's
// next delivery, never delivered as a turn of its own.
export async function keepTeammateContext(
  transaction: CloudDatabase,
  conversation: ConnectorConversation,
  message: {
    messageId: string
    workspaceId: string
    authorId: string
    authorName?: string
    text: string
  },
  now: number
): Promise<void> {
  await transaction.query(
    `INSERT INTO connector_thread_context
     (source, external_id, message_id, workspace_id, author_id, author_name, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, external_id, message_id) DO NOTHING`,
    [
      ...conversationKey(conversation),
      message.messageId,
      message.workspaceId,
      message.authorId,
      message.authorName ?? null,
      message.text,
      now
    ]
  )
}

// Teammates' messages go along once their author is freshly confirmed a trusted member of the
// workspace; the rest wait for the source's membership check.
export async function withTeammateContext(
  transaction: CloudDatabase,
  adapter: Pick<ConnectorAdapter, 'trustedNames' | 'teammateContext'>,
  conversation: ConnectorConversation & { workspaceId: string },
  ownerText: string
): Promise<string> {
  const key = conversationKey(conversation)
  const kept = await transaction.query(
    `SELECT message_id, author_id, author_name, text FROM connector_thread_context
     WHERE source = ? AND external_id = ? ORDER BY message_id`,
    key
  )
  const names = await adapter.trustedNames(
    transaction,
    conversation.workspaceId,
    kept.map((row) => String(row.author_id))
  )
  const lines = kept.flatMap((row) => {
    const authorId = String(row.author_id)
    if (!names.has(authorId)) {
      return []
    }
    const name =
      names.get(authorId) ?? (row.author_name === null ? authorId : String(row.author_name))
    return [{ messageId: row.message_id, name, text: String(row.text) }]
  })
  if (lines.length === 0) {
    return ownerText
  }
  await transaction.query(
    `DELETE FROM connector_thread_context
     WHERE source = ? AND external_id = ? AND message_id IN (${lines.map(() => '?').join(', ')})`,
    [...key, ...lines.map((line) => line.messageId)]
  )
  return adapter.teammateContext(lines, ownerText)
}
