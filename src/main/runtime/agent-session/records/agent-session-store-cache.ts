import { decodePersistedAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import { isDeepStrictEqual } from 'node:util'
import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'
import { AgentSessionTabTable } from '../agent-session-tab-table'
import type { AgentSessionStoreRowWrites } from '../../../native-chat/agent-session-journal/journal-writer-store-row-changes'
import type { AgentSessionStoreState } from './agent-session-store-state'
import {
  isReadableAgentSessionStoreOperation,
  isReadableAgentSessionStoreRecord
} from './agent-session-store-row-rules'

/** Live adoption preserves the saved lease; startup's unreconciled policy does not apply. */
export function applyAgentSessionStoreCacheRows(
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

/** Unreadable rows are derived at load and never written, so the draft shares them. */
export function copyAgentSessionStoreCache(state: AgentSessionStoreState): AgentSessionStoreState {
  return {
    ...state,
    records: new Map(state.records),
    operations: new Map(state.operations),
    retiredClaimKeys: [...state.retiredClaimKeys],
    sessionTabs: state.sessionTabs?.clone() ?? null
  }
}

export function notifyAgentSessionStoreCacheChanges(
  before: AgentSessionStoreState,
  after: AgentSessionStoreState,
  writes: AgentSessionStoreRowWrites
): void {
  const topologyChanged =
    writes.sessionTabs !== null ||
    writes.records.remove.length > 0 ||
    writes.records.upsert.some(([id]) => {
      const previous = before.records.get(id)
      const next = after.records.get(id)
      return (
        !previous ||
        !next ||
        previous.lease.claimStatus !== next.lease.claimStatus ||
        previous.provider !== next.provider ||
        !isDeepStrictEqual(previous.location, next.location) ||
        !isDeepStrictEqual(previous.conversationCommand, next.conversationCommand)
      )
    })
  const renamed = writes.records.upsert
    .filter(
      ([id]) => before.records.get(id)?.conversationName !== after.records.get(id)?.conversationName
    )
    .map(([id]) => id)
  if (topologyChanged) {
    sessionCrewChanges.notify(new Set(['records']))
  } else if (renamed.length) {
    sessionCrewChanges.notify(Object.assign(new Set(['names'] as const), { recordIds: renamed }))
  }
}
