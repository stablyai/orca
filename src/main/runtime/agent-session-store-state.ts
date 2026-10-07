// The agent-session store's in-memory state: loaded from the chat journal database and written
// back to it row by row (agent-session-record-rows.ts).

import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionTabTable } from './agent-session-tab-table'

export type RetiredAgentSessionClaimKey = { keyId: string; retiredAt: number }

export type AgentSessionStoreState = {
  records: Map<string, AgentSessionRecord>
  operations: Map<string, AgentSessionOperationRow>
  retiredClaimKeys: RetiredAgentSessionClaimKey[]
  /** Rows this build cannot validate, kept with a durable refusal reason. */
  unreadableRecords: Map<string, { reason: string; raw: unknown }>
  /** Chat tab id → the conversation it shows; null until this store first records a tab. */
  sessionTabs: AgentSessionTabTable | null
}
