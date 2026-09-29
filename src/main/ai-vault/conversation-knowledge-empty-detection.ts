import type { ConversationKnowledgeItem } from '../../shared/conversation-knowledge-items'
import type { AiVaultHistoryReadResult } from '../../shared/ai-vault-history-types'
import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import { conversationKnowledgeId } from './conversation-knowledge-source-session'

export function isPotentialLegacyEmptySummary(item: ConversationKnowledgeItem): boolean {
  const text = [
    item.knowledge.summary,
    ...item.knowledge.topics,
    ...item.knowledge.conclusions
  ].join(' ')
  return (
    /(?:空对话|未包含任何可读取|没有任何可读取|无任何可读取|没有可读取|无可读取)/u.test(text) ||
    /(?:no|without) (?:readable )?(?:user |assistant |conversation )?messages/i.test(text)
  )
}

export function readableConversationMessages<T extends { role: string; text: string }>(
  messages: readonly T[]
): T[] {
  return messages.filter(
    (message) => message.text.trim() && ['user', 'assistant'].includes(message.role)
  )
}

export async function findVerifiedLegacyEmptyIds(input: {
  sessions: readonly AiVaultSession[]
  items: readonly ConversationKnowledgeItem[]
  knownEmptyIds: ReadonlySet<string>
  readSession(args: { agent: AiVaultAgent; sessionId: string }): Promise<AiVaultHistoryReadResult>
}): Promise<Set<string>> {
  const sessionsById = new Map(
    input.sessions.map((session) => [conversationKnowledgeId(session), session])
  )
  const candidates = input.items.filter(
    (item) => !input.knownEmptyIds.has(item.id) && isPotentialLegacyEmptySummary(item)
  )
  const verifiedIds = await Promise.all(
    candidates.map(async (item) => {
      const session = sessionsById.get(item.id)
      if (!session) {
        return null
      }
      const history = await input.readSession({
        agent: session.agent,
        sessionId: session.sessionId
      })
      return readableConversationMessages(history.messages).length === 0 ? item.id : null
    })
  )
  return new Set(verifiedIds.filter((id): id is string => id !== null))
}
