import type { AgentSessionLease, AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'

export type StructuredProviderSessionOwnership = {
  sessionId: string
  workspaceId: string
  provider: StructuredAgentId
  providerSessionId: string
  conversationName?: string
  lease: AgentSessionLease
}

export function listStructuredProviderSessionOwnership(
  records: readonly AgentSessionRecord[]
): StructuredProviderSessionOwnership[] {
  return records.flatMap((record) =>
    record.providerHandleChain.map((link) => ({
      sessionId: record.sessionId,
      workspaceId: record.location.workspaceId,
      provider: record.provider,
      providerSessionId: link.handle.nativeId,
      conversationName: record.conversationName,
      lease: record.lease
    }))
  )
}
