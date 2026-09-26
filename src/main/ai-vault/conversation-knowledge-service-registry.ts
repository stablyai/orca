import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { listAiVaultSessions } from './cached-session-list'
import { ConversationKnowledgeService } from './conversation-knowledge-service'
import { ConversationKnowledgeStore } from './conversation-knowledge-store'
import { ConversationKnowledgeIndexCheckpointStore } from './conversation-knowledge-index-checkpoint-store'
import { enrichAiVaultSession } from './session-enrichment'
import { readAiVaultHistorySession } from './session-history'

type ServiceEntry = {
  service: ConversationKnowledgeService | null
  getEnvironmentResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined
}

const entries = new Map<string, ServiceEntry>()

export function getConversationKnowledgeService(options: {
  userDataPath: string
  getEnvironmentResolvers?: () => CommitMessageAgentEnvironmentResolvers | undefined
}): ConversationKnowledgeService {
  const existing = entries.get(options.userDataPath)
  if (existing?.service) {
    if (options.getEnvironmentResolvers) {
      existing.getEnvironmentResolvers = options.getEnvironmentResolvers
    }
    return existing.service
  }
  const entry: ServiceEntry = {
    getEnvironmentResolvers: options.getEnvironmentResolvers ?? (() => undefined),
    service: null
  }
  entry.service = new ConversationKnowledgeService({
    listSessions: async () => (await listAiVaultSessions({ unlimited: true })).sessions,
    readSession: (args) => readAiVaultHistorySession({ ...args, limit: 200 }),
    enrich: (args) =>
      enrichAiVaultSession({
        ...args,
        environmentResolvers: entry.getEnvironmentResolvers()
      }),
    store: new ConversationKnowledgeStore(options.userDataPath),
    checkpointStore: new ConversationKnowledgeIndexCheckpointStore(options.userDataPath)
  })
  entries.set(options.userDataPath, entry)
  return entry.service
}

export function resetConversationKnowledgeServicesForTests(): void {
  entries.clear()
}
