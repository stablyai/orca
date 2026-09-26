/**
 * A transaction applies to a draft of the published store state and the queue publishes the draft
 * only once it is durable, so no reader ever sees a change that might still roll back.
 */

import type { AgentSessionStoreState } from './agent-session-record-store-file'
import {
  isReadableAgentSessionStoreOperation,
  isReadableAgentSessionStoreRecord,
  isReadableAgentSessionStoreTab,
  isReadableAgentSessionStoreUnusableRecord,
  isReadableRetiredAgentSessionClaimKey
} from './agent-session-store-row-rules'

export function draftAgentSessionStoreState(state: AgentSessionStoreState): AgentSessionStoreState {
  return {
    ...state,
    records: new Map(state.records),
    operations: new Map(state.operations),
    retiredClaimKeys: [...state.retiredClaimKeys],
    unreadableRecords: new Map(state.unreadableRecords),
    sessionTabs: state.sessionTabs?.clone() ?? null
  }
}

/** What a draft changed relative to the published state, by identity. */
export type AgentSessionStoreDraftChanges = {
  changed: boolean
  /** Keys whose row the draft added or replaced; removals need no check. */
  records: string[]
  operations: string[]
  unreadableRecords: string[]
  retiredClaimKeys: boolean
  sessionTabs: boolean
}

/** Keys whose value `next` added or replaced, and whether anything differs at all. */
function changedKeys<V>(
  published: ReadonlyMap<string, V>,
  next: ReadonlyMap<string, V>
): { changed: boolean; keys: string[] } {
  const keys: string[] = []
  for (const [key, value] of next) {
    if (published.get(key) !== value) {
      keys.push(key)
    }
  }
  return { changed: keys.length > 0 || published.size !== next.size, keys }
}

export function agentSessionStoreDraftChanges(
  published: AgentSessionStoreState,
  draft: AgentSessionStoreState
): AgentSessionStoreDraftChanges {
  const records = changedKeys(published.records, draft.records)
  const operations = changedKeys(published.operations, draft.operations)
  const unreadableRecords = changedKeys(published.unreadableRecords, draft.unreadableRecords)
  const sessionTabs =
    published.sessionTabs && draft.sessionTabs
      ? !published.sessionTabs.equals(draft.sessionTabs)
      : published.sessionTabs !== draft.sessionTabs
  const retiredClaimKeys =
    published.retiredClaimKeys.length !== draft.retiredClaimKeys.length ||
    published.retiredClaimKeys.some((entry, index) => entry !== draft.retiredClaimKeys[index])
  return {
    changed:
      records.changed ||
      operations.changed ||
      unreadableRecords.changed ||
      sessionTabs ||
      retiredClaimKeys,
    records: records.keys,
    operations: operations.keys,
    unreadableRecords: unreadableRecords.keys,
    retiredClaimKeys,
    sessionTabs
  }
}

/**
 * Rejects a draft holding a changed row that a load would refuse. Loads skip the bytes this build
 * wrote, so a row that fails here would otherwise live in memory while every other reader of the
 * file quarantines it.
 */
export function assertAgentSessionStoreDraftReadable(
  draft: AgentSessionStoreState,
  changes: AgentSessionStoreDraftChanges
): void {
  const readable =
    changes.records.every((sessionId) =>
      isReadableAgentSessionStoreRecord(sessionId, draft.records.get(sessionId))
    ) &&
    changes.operations.every((key) =>
      isReadableAgentSessionStoreOperation(key, draft.operations.get(key))
    ) &&
    changes.unreadableRecords.every((sessionId) =>
      isReadableAgentSessionStoreUnusableRecord(draft.unreadableRecords.get(sessionId))
    ) &&
    (!changes.retiredClaimKeys ||
      draft.retiredClaimKeys.every(isReadableRetiredAgentSessionClaimKey)) &&
    (!changes.sessionTabs ||
      (draft.sessionTabs?.entries() ?? []).every(([tabId, sessionId]) =>
        isReadableAgentSessionStoreTab({ tabId, sessionId })
      ))
  if (!readable) {
    throw new Error('agent_session_store_write_invalid')
  }
}
