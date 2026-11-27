// The receipt that a provider context holds the host's current instructions, written only once the
// agent took the turn that carried them, by the owner that sent them, into the same context.
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionProviderHandleChainHead,
  type AgentSessionProviderHandleLink
} from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { agentSessionProviderHandleRoot } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

/** Which provider context a record names: a /clear, a rewind or another provider conversation (a
 *  new handle root; a moved resume cursor is the same one) starts another. */
export function agentSessionInstructionsContext(record: AgentSessionRecord): string {
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  return JSON.stringify([
    head ? agentSessionProviderHandleRoot(head.handle) : null,
    record.providerContextBoundary?.operationId ?? null,
    record.rewind?.operationId ?? null,
    record.rewind?.phase ?? null
  ])
}

export type AgentSessionInstructionsReceipt = {
  sessionId: string
  fence: number
  /** The key the turn sent, taken when it was planned. */
  key: string
  /** `agentSessionInstructionsContext` when the turn was planned. */
  context: string
}

/** Unchanged when another owner holds the session or its context changed since the turn was planned. */
export function recordAgentSessionInstructionsKey(
  record: AgentSessionRecord,
  receipt: AgentSessionInstructionsReceipt
): AgentSessionRecord {
  const { lease } = record
  if (
    lease.runtimeFence !== receipt.fence ||
    lease.claimStatus !== 'live' ||
    agentSessionInstructionsContext(record) !== receipt.context ||
    record.instructionsKey === receipt.key
  ) {
    return record
  }
  return { ...record, instructionsKey: receipt.key }
}

/** A confirmed open's receipt: an agent that rebuilds its prompt, or a new conversation, was given the
 *  launch's instructions; a resumed one keeps what the record already says. */
export function withOpenedAgentSessionInstructionsKey(
  record: AgentSessionRecord,
  launched: { key: string; rebuilt: boolean } | null | undefined,
  opened: AgentSessionProviderHandleLink
): AgentSessionRecord {
  return launched && (launched.rebuilt || opened.origin === 'created')
    ? { ...record, instructionsKey: launched.key }
    : record
}

/** A context the record no longer vouches for: the next confirmed start or taken update sets it again. */
export function withoutAgentSessionInstructionsKey(record: AgentSessionRecord): AgentSessionRecord {
  const { instructionsKey: _dropped, ...rest } = record
  return rest
}
