import type {
  AgentSessionOwnerObservation,
  AgentSessionConversationView
} from '../../../shared/agent-session-conversation-view'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import { structuredAgentRuntimeMetadata } from '../../runtime/structured-agent-runtime-metadata'

export type StructuredProviderSessionOwnership = {
  sessionId: string
  workspaceId: string
  provider: StructuredAgentId
  providerSessionId: string
  conversationName?: string
  ownerObservation: AgentSessionOwnerObservation
}

/** Which chat owns each conversation, under the Session History row id its agent's registration
 *  names: the one index both the duplicate-adoption check and Session History ownership read. */
export function listStructuredProviderSessionOwnership(
  records: readonly AgentSessionConversationView[]
): StructuredProviderSessionOwnership[] {
  return records.flatMap((record) => {
    const history = structuredAgentRuntimeMetadata(record.provider)?.sessionHistory
    return history
      ? record.providerHandleChain.map((link) => ({
          sessionId: record.sessionId,
          workspaceId: record.location.workspaceId,
          provider: record.provider,
          providerSessionId: history.rowSessionId(link),
          conversationName: record.conversationName,
          ownerObservation: record.ownerObservation
        }))
      : []
  })
}
