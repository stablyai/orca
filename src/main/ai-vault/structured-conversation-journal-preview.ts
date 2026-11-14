import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { AiVaultSession } from '../../shared/ai-vault/contracts/ai-vault-types'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type { JournalSqlDatabase } from '../native-chat/agent-session-journal/database/journal-sql-database'

export type StructuredConversationJournalPreview = {
  conversationContent: NonNullable<AiVaultSession['conversationContent']>
  firstUserPrompt?: string
}

export async function readStructuredConversationJournalPreviews(
  database: { readers: Pick<JournalSqlDatabase['readers'], 'point'> } | undefined,
  records: readonly AgentSessionRecord[]
): Promise<ReadonlyMap<string, StructuredConversationJournalPreview>> {
  if (!database) {
    return new Map()
  }
  const entries = await mapWithConcurrency(records, 4, async (record) => {
    let preview: StructuredConversationJournalPreview = { conversationContent: 'unknown' }
    try {
      const result = await database.readers.point({
        sessionId: record.sessionId,
        operation: { kind: 'conversation-preview', workspaceId: record.location.workspaceId }
      })
      if (result.kind === 'conversation-preview') {
        preview = result.preview
      }
    } catch {
      // Unavailable history must remain discoverable.
    }
    return [record.sessionId, preview] as const
  })
  return new Map(entries)
}
