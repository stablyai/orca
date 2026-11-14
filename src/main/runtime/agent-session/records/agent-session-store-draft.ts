// Publish drafts only after row commit so readers never see changes that can roll back.

import { encodeAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentSessionStoreState,
  RetiredAgentSessionClaimKey
} from './agent-session-store-state'
import {
  isReadableAgentSessionStoreOperation,
  isReadableAgentSessionStoreRecord,
  isReadableAgentSessionStoreTab,
  isReadableRetiredAgentSessionClaimKey
} from './agent-session-store-row-rules'
import type { PersistedAgentSessionTab } from '../agent-session-tab-table'

/** A draft's records, remembering which keys went to the end: a Map appends a key set while
 *  absent (new, or deleted first) and keeps a re-set key's place. */
export class AgentSessionDraftRecords extends Map<string, AgentSessionRecord> {
  /** In the order they now sit at the end; a key deleted again may be listed but absent. */
  readonly appended = new Set<string>()

  constructor(published: ReadonlyMap<string, AgentSessionRecord>) {
    super()
    for (const [key, value] of published) {
      super.set(key, value)
    }
  }

  override set(key: string, value: AgentSessionRecord): this {
    if (!this.has(key)) {
      this.appended.delete(key)
      this.appended.add(key)
    }
    return super.set(key, value)
  }
}

/** Unreadable rows are derived at load and never written, so the draft shares them. */
export function draftAgentSessionStoreState(state: AgentSessionStoreState): AgentSessionStoreState {
  return {
    ...state,
    records: new AgentSessionDraftRecords(state.records),
    operations: new Map(state.operations),
    retiredClaimKeys: [...state.retiredClaimKeys],
    sessionTabs: state.sessionTabs?.clone() ?? null
  }
}

type KeyedRowWrites = { upsert: [key: string, json: string][]; remove: string[] }

export type AgentSessionStoreRowWrites = {
  records: KeyedRowWrites
  operations: KeyedRowWrites
  /** The whole list when it changed, else null. */
  retiredClaimKeys: RetiredAgentSessionClaimKey[] | null
  /** Complete changed index; recorded: false distinguishes a never-recorded index. */
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

/** Diff rows by identity; validate their serialized form with load rules before committing. */
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
  const operations = serializeChangedRows(published.operations, draft.operations, (key, written) =>
    isReadableAgentSessionStoreOperation(key, written)
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
    operations.upsert.length > 0 ||
    operations.remove.length > 0 ||
    retiredClaimKeys !== null ||
    tabsChanged
  if (!changed) {
    return null
  }
  return {
    records,
    operations,
    retiredClaimKeys,
    sessionTabs: tabsChanged ? { recorded: draft.sessionTabs !== null, tabs } : null
  }
}
