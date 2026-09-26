import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ConversationKnowledgeItem } from '../../shared/conversation-knowledge-items'
import { conversationKnowledgeId } from './conversation-knowledge-source-session'

export function conversationKnowledgeSource(
  session: AiVaultSession
): ConversationKnowledgeItem['source'] {
  return {
    executionHostId: session.executionHostId,
    agent: session.agent,
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    modifiedAt: session.modifiedAt
  }
}

export function hydrateConversationKnowledgeSourceTimes(
  items: readonly ConversationKnowledgeItem[],
  sessions: readonly AiVaultSession[]
): ConversationKnowledgeItem[] {
  const sessionByKnowledgeId = new Map(
    sessions.map((session) => [conversationKnowledgeId(session), session])
  )
  return items.map((item) => {
    const session = sessionByKnowledgeId.get(item.id)
    return session
      ? {
          ...item,
          source: {
            ...item.source,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            modifiedAt: session.modifiedAt
          }
        }
      : item
  })
}
