import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionLease, AgentSessionRecord } from '../../../shared/agent-session-record'

export type StructuredProviderSessionOwnership = {
  sessionId: string
  workspaceId: string
  provider: 'claude' | 'codex'
  providerSessionId: string
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
      providerSessionId:
        link.handle.provider === 'codex' ? link.handle.threadId : link.handle.sessionId,
      lease: record.lease
    }))
  )
}

/**
 * Provider conversation the session currently writes to, or null while the provider has not proven
 * one. Only the chain head counts: an earlier link names a conversation this session has moved on
 * from, and a fork's root is a different conversation entirely.
 */
export function headStructuredProviderSessionId(record: AgentSessionRecord): string | null {
  const handle = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
  if (!handle) {
    return null
  }
  return handle.provider === 'codex' ? handle.threadId : handle.sessionId
}
