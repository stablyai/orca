import type { AiVaultHistoryReadResult } from '../../shared/ai-vault-history-types'
import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import type { ConversationKnowledgeItem } from '../../shared/conversation-knowledge-items'
import type { ConversationKnowledgeIndexCheckpointStore } from './conversation-knowledge-index-checkpoint-store'
import type { enrichAiVaultSession } from './session-enrichment'

export type ConversationKnowledgeServiceDependencies = {
  listSessions(): Promise<AiVaultSession[]>
  readSession(args: { agent: AiVaultAgent; sessionId: string }): Promise<AiVaultHistoryReadResult>
  enrich: typeof enrichAiVaultSession
  store: {
    list(): Promise<ConversationKnowledgeItem[]>
    upsert(item: ConversationKnowledgeItem): Promise<void>
    remove(ids: readonly string[]): Promise<void>
  }
  checkpointStore?: Pick<ConversationKnowledgeIndexCheckpointStore, 'read' | 'write'>
}
