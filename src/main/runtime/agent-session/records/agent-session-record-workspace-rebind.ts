import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation,
  type AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  requireWritableAgentSessionRecord,
  type AgentSessionStoreState
} from './agent-session-store-state'

/** Moves one record to its recovered workspace inside a receipt; returns false when already there. */
export function rebindAgentSessionRecordWorkspace(
  draft: AgentSessionStoreState,
  sessionId: string,
  original: AgentSessionExecutionLocation,
  location: AgentSessionExecutionLocation,
  check: (record: AgentSessionRecord) => void
): boolean {
  const record = requireWritableAgentSessionRecord(draft, sessionId)
  if (agentSessionExecutionLocationsEqual(record.location, location)) {
    return false
  }
  check(record)
  if (!agentSessionExecutionLocationsEqual(record.location, original)) {
    throw new Error('Chat workspace changed during recovery')
  }
  draft.records.set(sessionId, { ...record, location })
  return true
}

/** The journal names the same workspace as its record, so both move in one commit. */
export const REBIND_JOURNAL_WORKSPACE_SQL =
  'UPDATE journal_sessions SET workspace_id = ? WHERE session_id = ?'

export async function rebindAgentSessionWorkspace(
  transactions: AgentSessionStoreTransactions,
  sessionId: string,
  original: AgentSessionExecutionLocation,
  location: AgentSessionExecutionLocation,
  check: (record: AgentSessionRecord) => void
): Promise<void> {
  let changed = false
  const receipt = transactions.receipt((draft) => {
    changed = rebindAgentSessionRecordWorkspace(draft, sessionId, original, location, check)
  })
  await transactions.commitReceipt({
    write: (db) => {
      receipt.write(db)
      if (changed) {
        db.prepare(REBIND_JOURNAL_WORKSPACE_SQL).run(location.workspaceId, sessionId)
      }
    },
    committed: () => receipt.committed()
  })
}
