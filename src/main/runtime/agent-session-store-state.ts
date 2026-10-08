// Session records are published after commit; operation receipts are queried on the same database.

import type { AgentSessionOperationRepository } from './agent-session-operation-repository'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionOrcaStopCause } from '../../shared/agent-session-orca-stop'
import type { AgentSessionTabTable } from './agent-session-tab-table'

export type RetiredAgentSessionClaimKey = { keyId: string; retiredAt: number }

export type AgentSessionStoreState = {
  records: Map<string, AgentSessionRecord>
  operations: AgentSessionOperationRepository
  retiredClaimKeys: RetiredAgentSessionClaimKey[]
  /** Rows this build cannot validate, kept with a durable refusal reason. */
  unreadableRecords: Map<string, { reason: string; raw: unknown }>
  /** Chat tab id → the conversation it shows; null until this store first records a tab. */
  sessionTabs: AgentSessionTabTable | null
  /** How each earlier runtime recorded here ended: its quit or update, or a crash when it started
   *  and never ended; read once at load. A runtime it lacks, or null, attributes no death to Orca. */
  runtimeEnds?: ReadonlyMap<string, AgentSessionOrcaStopCause> | null
}

/** Every session id the state holds a row for, readable or not. */
export function heldAgentSessionIds(state: AgentSessionStoreState): string[] {
  return [...state.records.keys(), ...state.unreadableRecords.keys()]
}
