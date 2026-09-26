import type { AiVaultHistoryReadResult } from '../../shared/ai-vault-history-types'
import {
  isAiVaultSessionResumableContent,
  type AiVaultAgent,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import type { ConversationKnowledgeItem } from '../../shared/conversation-knowledge-items'
import { isConversationKnowledgeGenerationTitle } from '../../shared/conversation-knowledge-items'
import { findVerifiedLegacyEmptyIds } from './conversation-knowledge-empty-detection'
import {
  conversationKnowledgeId,
  conversationPathIsWithin,
  isKnowledgeGenerationSession
} from './conversation-knowledge-source-session'
import { visibleConversationKnowledgeItems } from './conversation-knowledge-visible-items'

export async function listConversationKnowledge(input: {
  scopePaths?: readonly string[]
  listSessions(): Promise<AiVaultSession[]>
  readSession(args: { agent: AiVaultAgent; sessionId: string }): Promise<AiVaultHistoryReadResult>
  store: {
    list(): Promise<ConversationKnowledgeItem[]>
    remove(ids: readonly string[]): Promise<void>
  }
}): Promise<ConversationKnowledgeItem[]> {
  const [items, sessions] = await Promise.all([input.store.list(), input.listSessions()])
  const generatedIds = items
    .filter((item) => isConversationKnowledgeGenerationTitle(item.source.title))
    .map((item) => item.id)
  await input.store.remove(generatedIds)
  const activeItems = generatedIds.length
    ? items.filter((item) => !generatedIds.includes(item.id))
    : items
  const sourceSessions = sessions.filter((session) => !isKnowledgeGenerationSession(session))
  const emptyIds = new Set(
    sourceSessions
      .filter((session) => !isAiVaultSessionResumableContent(session))
      .map(conversationKnowledgeId)
  )
  await input.store.remove(
    activeItems.filter((item) => emptyIds.has(item.id)).map((item) => item.id)
  )
  const legacyEmptyIds = await findVerifiedLegacyEmptyIds({
    sessions: sourceSessions,
    items: activeItems,
    knownEmptyIds: emptyIds,
    readSession: input.readSession
  })
  await input.store.remove([...legacyEmptyIds])
  const visible = visibleConversationKnowledgeItems({
    items: activeItems,
    sourceSessions,
    emptyIds,
    legacyEmptyIds
  })
  const scopePaths = input.scopePaths
  return scopePaths?.length
    ? visible.filter(
        (item) =>
          item.source.cwd !== null &&
          scopePaths.some((path) => conversationPathIsWithin(path, item.source.cwd!))
      )
    : visible
}
