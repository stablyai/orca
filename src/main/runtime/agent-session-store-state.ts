import {
  agentSessionConversationView,
  type AgentSessionConversationView
} from '../../shared/agent-session-conversation-view'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionOrcaStopCause } from '../../shared/agent-session-orca-stop'
import type { AgentSessionTabTable } from './agent-session/agent-session-tab-table'

export type RetiredAgentSessionClaimKey = { keyId: string; retiredAt: number }

export type AgentSessionStoreState = {
  records: Map<string, AgentSessionRecord>
  operations: Map<string, AgentSessionOperationRow>
  retiredClaimKeys: RetiredAgentSessionClaimKey[]
  /** Rows this build cannot validate, kept with a durable refusal reason. */
  unreadableRecords: Map<
    string,
    { reason: string; raw: unknown; conversation?: AgentSessionConversationView }
  >
  /** Chat tab id → the conversation it shows; null until this store first records a tab. */
  sessionTabs: AgentSessionTabTable | null
  /** Prior runtime endings, read at load; missing/null evidence attributes no death to Orca. */
  runtimeEnds?: ReadonlyMap<string, AgentSessionOrcaStopCause> | null
}

export function heldAgentSessionIds(state: AgentSessionStoreState): string[] {
  return [...state.records.keys(), ...state.unreadableRecords.keys()]
}

export function getAgentSessionConversation(
  state: AgentSessionStoreState,
  id: string
): AgentSessionConversationView | null {
  const record = state.records.get(id)
  return record
    ? agentSessionConversationView(record)
    : (state.unreadableRecords.get(id)?.conversation ?? null)
}

export function hasAgentSessionConversation(state: AgentSessionStoreState, id: string): boolean {
  return state.records.has(id) || !!state.unreadableRecords.get(id)?.conversation
}

export function listAgentSessionConversations(
  state: AgentSessionStoreState
): AgentSessionConversationView[] {
  return [...state.records.values()]
    .map(agentSessionConversationView)
    .concat(
      [...state.unreadableRecords.values()].flatMap((row) =>
        row.conversation ? [row.conversation] : []
      )
    )
}

export function selectWritableAgentSessionRecord(state: AgentSessionStoreState, id: string) {
  const record = state.records.get(id)
  return record
    ? { kind: 'writable' as const, record }
    : { kind: state.unreadableRecords.has(id) ? ('unreadable' as const) : ('missing' as const) }
}

/** The shared authority boundary for any fresh effect, distinct from conversation presence. */
export function requireWritableAgentSessionRecord(
  state: AgentSessionStoreState,
  id: string
): AgentSessionRecord {
  const selected = selectWritableAgentSessionRecord(state, id)
  if (selected.kind === 'writable') {
    return selected.record
  }
  throw selected.kind === 'unreadable'
    ? agentSessionRefusalError('execution_owner_reconciling', { reason: 'recordUnreadable' })
    : agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
}
