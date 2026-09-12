import {
  agentSessionProviderHandleChainHead,
  type AgentSessionProviderHandle
} from '../../../shared/agent-session-provider-handle'
import type { AgentSessionLease, AgentSessionRecord } from '../../../shared/agent-session-record'

/** The two lanes name a conversation differently: Claude by session id, Codex by thread id. */
function providerSessionIdForHandle(handle: AgentSessionProviderHandle): string {
  return handle.provider === 'codex' ? handle.threadId : handle.sessionId
}

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
      providerSessionId: providerSessionIdForHandle(link.handle),
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
  // A row with no chain at all is unknown identity, not a crash: this runs inside tab publication.
  const handle = agentSessionProviderHandleChainHead(record.providerHandleChain ?? [])?.handle
  return handle ? providerSessionIdForHandle(handle) : null
}
