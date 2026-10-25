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
  unreadableRecords: Map<string, { reason: string; raw: unknown }>
  /** Chat tab id → the conversation it shows; null until this store first records a tab. */
  sessionTabs: AgentSessionTabTable | null
  /** Prior runtime endings, read at load; missing/null evidence attributes no death to Orca. */
  runtimeEnds?: ReadonlyMap<string, AgentSessionOrcaStopCause> | null
}

export function heldAgentSessionIds(state: AgentSessionStoreState): string[] {
  return [...state.records.keys(), ...state.unreadableRecords.keys()]
}
