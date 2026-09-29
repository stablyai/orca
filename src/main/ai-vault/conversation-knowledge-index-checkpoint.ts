import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ConversationKnowledgeIndexStatus } from '../../shared/conversation-knowledge-items'
import type { ConversationKnowledgeIndexCheckpoint } from './conversation-knowledge-index-checkpoint-store'
import type { ConversationKnowledgeServiceDependencies } from './conversation-knowledge-service-dependencies'

export async function readResumableConversationKnowledgeIndex(
  input: Pick<ConversationKnowledgeServiceDependencies, 'checkpointStore' | 'listSessions'>
): Promise<{
  checkpoint: ConversationKnowledgeIndexCheckpoint
  sessions: AiVaultSession[]
} | null> {
  const checkpoint = await input.checkpointStore?.read()
  if (!checkpoint || checkpoint.state !== 'running') {
    return null
  }
  const allSessions = await input.listSessions()
  const sessions = checkpoint.pending.flatMap((saved) => {
    const session = allSessions.find(
      (candidate) =>
        candidate.executionHostId === saved.executionHostId &&
        candidate.agent === saved.agent &&
        candidate.sessionId === saved.sessionId
    )
    return session ? [session] : []
  })
  return sessions.length ? { checkpoint, sessions } : null
}

export function writeConversationKnowledgeIndexCheckpoint(input: {
  store: ConversationKnowledgeServiceDependencies['checkpointStore']
  state: ConversationKnowledgeIndexCheckpoint['state']
  config: ConversationKnowledgeIndexCheckpoint['config'] | null
  status: ConversationKnowledgeIndexStatus
  sessions: readonly AiVaultSession[]
}): void {
  if (!input.store || !input.config) {
    return
  }
  input.store.write({
    version: 1,
    state: input.state,
    config: input.config,
    total: input.status.total,
    completed: input.status.completed,
    failed: input.status.failed,
    pending: input.sessions.map((session) => ({
      executionHostId: session.executionHostId,
      agent: session.agent,
      sessionId: session.sessionId
    }))
  })
}

export function isCanceledConversationKnowledgeGeneration(error: unknown): boolean {
  return error instanceof Error && /generation canceled/i.test(error.message)
}
