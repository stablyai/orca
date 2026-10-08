/**
 * A transaction applies to a draft of the published store state, and the store publishes the draft
 * only once its rows have committed, so no reader ever sees a change that might still roll back.
 */

import { encodeAgentSessionRecord } from '../../shared/agent-session-record-stored-form'
import type {
  AgentSessionStoreState,
  RetiredAgentSessionClaimKey
} from './agent-session-store-state'
import {
  isReadableAgentSessionStoreRecord,
  isReadableAgentSessionStoreTab,
  isReadableRetiredAgentSessionClaimKey
} from './agent-session-store-row-rules'
import type { PersistedAgentSessionTab } from './agent-session-tab-table'

/** Unreadable rows are derived at load and never written, so the draft shares them. */
export function draftAgentSessionStoreState(state: AgentSessionStoreState): AgentSessionStoreState {
  return {
    ...state,
    records: new Map(state.records),
    retiredClaimKeys: [...state.retiredClaimKeys],
    sessionTabs: state.sessionTabs?.clone() ?? null
  }
}

type KeyedRowWrites = { upsert: [key: string, json: string][]; remove: string[] }

/** Exactly the rows a draft changed, each serialized as it will be stored. */
export type AgentSessionStoreRowWrites = {
  records: KeyedRowWrites
  /** The whole list when it changed, else null. */
  retiredClaimKeys: RetiredAgentSessionClaimKey[] | null
  /** The whole index when it changed: `recorded: false` is a store that has never recorded one. */
  sessionTabs: { recorded: boolean; tabs: PersistedAgentSessionTab[] } | null
}

/** A row as a load parses it back: JSON drops `undefined` members that an in-memory check sees. */
function serializeChangedRows<V>(
  published: ReadonlyMap<string, V>,
  next: ReadonlyMap<string, V>,
  readable: (key: string, written: unknown) => boolean,
  stored: (value: V) => unknown = (value) => value
): KeyedRowWrites {
  const writes: KeyedRowWrites = { upsert: [], remove: [] }
  let added = 0
  for (const [key, value] of next) {
    const prior = published.get(key)
    if (prior === value) {
      continue
    }
    const json = JSON.stringify(stored(value))
    if (json === undefined || !readable(key, JSON.parse(json))) {
      throw new Error('agent_session_store_write_invalid')
    }
    writes.upsert.push([key, json])
    added += prior === undefined && !published.has(key) ? 1 : 0
  }
  // Only a size mismatch can hide a removal, so the common write never walks the published rows.
  if (published.size + added !== next.size) {
    for (const key of published.keys()) {
      if (!next.has(key)) {
        writes.remove.push(key)
      }
    }
  }
  return writes
}

function retiredClaimKeysChanged(
  published: readonly RetiredAgentSessionClaimKey[],
  next: readonly RetiredAgentSessionClaimKey[]
): boolean {
  return published.length !== next.length || published.some((entry, index) => entry !== next[index])
}

/**
 * The rows a draft changed relative to the published state, by identity, or null when it changed
 * none. Each changed row is checked as written against the rules a load applies, so a row a later
 * load would refuse rejects its own transaction instead of living in memory unreadable.
 */
export function agentSessionStoreDraftRowWrites(
  published: AgentSessionStoreState,
  draft: AgentSessionStoreState
): AgentSessionStoreRowWrites | null {
  const records = serializeChangedRows(
    published.records,
    draft.records,
    (sessionId, written) => isReadableAgentSessionStoreRecord(sessionId, written),
    encodeAgentSessionRecord
  )
  const retiredClaimKeys = retiredClaimKeysChanged(
    published.retiredClaimKeys,
    draft.retiredClaimKeys
  )
    ? draft.retiredClaimKeys
    : null
  if (
    retiredClaimKeys &&
    (!retiredClaimKeys.every((entry) =>
      isReadableRetiredAgentSessionClaimKey(JSON.parse(JSON.stringify(entry)))
    ) ||
      new Set(retiredClaimKeys.map((entry) => entry.keyId)).size !== retiredClaimKeys.length)
  ) {
    throw new Error('agent_session_store_write_invalid')
  }
  const tabsChanged =
    published.sessionTabs && draft.sessionTabs
      ? !published.sessionTabs.equals(draft.sessionTabs)
      : published.sessionTabs !== draft.sessionTabs
  const tabs = tabsChanged
    ? (draft.sessionTabs?.entries() ?? []).map(([tabId, sessionId]) => ({ tabId, sessionId }))
    : []
  if (!tabs.every(isReadableAgentSessionStoreTab)) {
    throw new Error('agent_session_store_write_invalid')
  }
  const changed =
    records.upsert.length > 0 ||
    records.remove.length > 0 ||
    retiredClaimKeys !== null ||
    tabsChanged
  if (!changed) {
    return null
  }
  return {
    records,
    retiredClaimKeys,
    sessionTabs: tabsChanged ? { recorded: draft.sessionTabs !== null, tabs } : null
  }
}
