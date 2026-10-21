import type { AgentSessionLease, AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import { structuredAgentRuntimeMetadata } from '../../runtime/structured-agent-runtime-metadata'

export type StructuredProviderSessionOwnership = {
  sessionId: string
  workspaceId: string
  provider: StructuredAgentId
  providerSessionId: string
  conversationName?: string
  lease: AgentSessionLease
}

/** Which chat owns each conversation, under the Session History row id its agent's registration
 *  names: the one index both the duplicate-adoption check and Session History ownership read. */
export function listStructuredProviderSessionOwnership(
  records: readonly AgentSessionRecord[]
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
          lease: record.lease
        }))
      : []
  })
}
