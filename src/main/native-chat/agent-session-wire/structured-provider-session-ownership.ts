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

/** Use registration-defined History row IDs for both ownership display and duplicate-adoption checks. */
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
