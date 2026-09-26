import type { AiVaultHistoryReadResult } from '../../shared/ai-vault-history-types'
import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import {
  CONVERSATION_KNOWLEDGE_FORMAT_VERSION,
  type ConversationKnowledgeItem
} from '../../shared/conversation-knowledge-items'
import type { TuiAgent } from '../../shared/tui-agent'
import type { enrichAiVaultSession } from './session-enrichment'
import { readableConversationMessages } from './conversation-knowledge-empty-detection'
import { conversationKnowledgeId } from './conversation-knowledge-source-session'
import { conversationKnowledgeSource } from './conversation-knowledge-source'
import { resolveKnowledgeTitle } from './conversation-knowledge-title'

type GenerateArgs = {
  sourceAgent: AiVaultAgent
  sessionId: string
  generatorAgent: TuiAgent
  generatorModel?: string | null
  language?: string
}

export async function generateConversationKnowledgeFromSession(input: {
  session: AiVaultSession
  args: GenerateArgs
  readSession(args: { agent: AiVaultAgent; sessionId: string }): Promise<AiVaultHistoryReadResult>
  enrich: typeof enrichAiVaultSession
  store: {
    upsert(item: ConversationKnowledgeItem): Promise<void>
    remove(ids: readonly string[]): Promise<void>
  }
}): Promise<ConversationKnowledgeItem | null> {
  const history = await input.readSession({
    agent: input.args.sourceAgent,
    sessionId: input.args.sessionId
  })
  const messages = readableConversationMessages(history.messages)
  if (!messages.length) {
    await input.store.remove([conversationKnowledgeId(input.session)])
    return null
  }
  const enrichment = await input.enrich({
    session: input.session,
    messages,
    agent: input.args.generatorAgent,
    model: input.args.generatorModel,
    language: input.args.language
  })
  const item: ConversationKnowledgeItem = {
    id: conversationKnowledgeId(input.session),
    source: conversationKnowledgeSource(input.session),
    knowledge: {
      title: resolveKnowledgeTitle(
        enrichment.title,
        input.session.title,
        enrichment.summary,
        messages
      ),
      summary: enrichment.summary,
      topics: enrichment.topics,
      conclusions: enrichment.conclusions,
      entities: enrichment.entities,
      searchTerms: enrichment.searchTerms,
      handoff: enrichment.handoff
    },
    generator: {
      agent: input.args.generatorAgent,
      model: enrichment.model,
      generatedAt: new Date().toISOString(),
      formatVersion: CONVERSATION_KNOWLEDGE_FORMAT_VERSION
    }
  }
  await input.store.upsert(item)
  return item
}
