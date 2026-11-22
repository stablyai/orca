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
    /(?:\u7a7a\u5bf9\u8bdd|\u672a\u5305\u542b\u4efb\u4f55\u53ef\u8bfb\u53d6|\u6ca1\u6709\u4efb\u4f55\u53ef\u8bfb\u53d6|\u65e0\u4efb\u4f55\u53ef\u8bfb\u53d6|\u6ca1\u6709\u53ef\u8bfb\u53d6|\u65e0\u53ef\u8bfb\u53d6)/u.test(
      text
    ) || /(?:no|without) (?:readable )?(?:user |assistant |conversation )?messages/i.test(text)
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
