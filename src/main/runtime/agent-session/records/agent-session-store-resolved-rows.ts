import { decodePersistedAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import { AgentSessionTabTable } from '../agent-session-tab-table'
import type { AgentSessionStoreRowWrites } from './agent-session-store-draft'
import type { AgentSessionStoreState } from './agent-session-store-state'
import {
  isReadableAgentSessionStoreOperation,
  isReadableAgentSessionStoreRecord
} from './agent-session-store-row-rules'

/** Live adoption preserves the saved lease; startup's unreconciled policy does not apply. */
export function adoptAgentSessionStoreResolvedRows(
  draft: AgentSessionStoreState,
  writes: AgentSessionStoreRowWrites
): void {
  for (const [id, json] of writes.records.upsert) {
    const saved: unknown = JSON.parse(json)
    if (!isReadableAgentSessionStoreRecord(id, saved)) {
      throw new Error('the writer returned an unreadable record')
    }
    draft.records.set(id, decodePersistedAgentSessionRecord(saved).record)
  }
  for (const id of writes.records.remove) {
    draft.records.delete(id)
  }
  for (const [key, json] of writes.operations.upsert) {
    const saved: unknown = JSON.parse(json)
    if (!isReadableAgentSessionStoreOperation(key, saved)) {
      throw new Error('the writer returned an unreadable operation')
    }
    draft.operations.set(key, saved)
  }
  for (const key of writes.operations.remove) {
    draft.operations.delete(key)
  }
  if (writes.retiredClaimKeys !== null) {
    draft.retiredClaimKeys = writes.retiredClaimKeys
  }
  if (writes.sessionTabs !== null) {
    draft.sessionTabs = writes.sessionTabs.recorded
      ? new AgentSessionTabTable(
          writes.sessionTabs.tabs.map(({ tabId, sessionId }) => [tabId, sessionId])
        )
      : null
  }
}
