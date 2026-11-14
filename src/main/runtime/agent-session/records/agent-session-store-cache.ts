import { decodePersistedAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { isDeepStrictEqual } from 'node:util'
import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'
import { AgentSessionTabTable } from '../agent-session-tab-table'
import type { AgentSessionStoreRowWrites } from '../../../native-chat/agent-session-journal/journal-writer-store-row-changes'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { agentSessionStoreRowChanges } from '../../../native-chat/agent-session-journal/journal-writer-store-row-changes'
import { changesAgentSenderIdentity } from './agent-session-sender-identity-revision'
import {
  isReadableAgentSessionStoreOperation,
  isReadableAgentSessionStoreRecord
} from './agent-session-store-row-rules'

/** Acknowledgements preserve the writer's installed lease and explicit recovery verdicts. */
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

/** Decode every acknowledgement before atomically adopting only its keys. */
export function prepareAgentSessionStoreCachePatch(
  published: AgentSessionStoreState,
  acknowledgements: readonly AgentSessionStoreRowWrites[]
) {
  const recordIds = new Set<string>()
  const operationKeys = new Set<string>()
  for (const rows of acknowledgements) {
    rows.records.upsert.forEach(([id]) => recordIds.add(id))
    rows.records.remove.forEach((id) => recordIds.add(id))
    rows.operations.upsert.forEach(([key]) => operationKeys.add(key))
    rows.operations.remove.forEach((key) => operationKeys.add(key))
  }
  const before: AgentSessionStoreState = {
    ...published,
    records: new Map(
      [...recordIds].flatMap((id) => {
        const row = published.records.get(id)
        return row ? [[id, row] as const] : []
      })
    ),
    operations: new Map(
      [...operationKeys].flatMap((key) => {
        const row = published.operations.get(key)
        return row ? [[key, row] as const] : []
      })
    )
  }
  const next = {
    ...before,
    records: new Map(before.records),
    operations: new Map(before.operations)
  }
  for (const rows of acknowledgements) {
    applyAgentSessionStoreCacheRows(next, rows)
  }
  for (const [id, row] of next.records) {
    const prior = before.records.get(id)
    if (prior && isDeepStrictEqual(prior, row)) {
      next.records.set(id, prior)
    }
  }
  for (const [key, row] of next.operations) {
    const prior = before.operations.get(key)
    if (prior && isDeepStrictEqual(prior, row)) {
      next.operations.set(key, prior)
    }
  }
  return { before, next, writes: agentSessionStoreRowChanges(before, next) }
}

export function adoptAgentSessionStoreCachePatch(
  published: AgentSessionStoreState,
  next: AgentSessionStoreState,
  writes: AgentSessionStoreRowWrites
): void {
  for (const [id] of writes.records.upsert) {
    published.records.set(id, next.records.get(id)!)
  }
  for (const id of writes.records.remove) {
    published.records.delete(id)
  }
  for (const [key] of writes.operations.upsert) {
    published.operations.set(key, next.operations.get(key)!)
  }
  for (const key of writes.operations.remove) {
    published.operations.delete(key)
  }
  if (writes.sessionTabs !== null) {
    published.sessionTabs = next.sessionTabs
  }
  if (writes.retiredClaimKeys !== null) {
    published.retiredClaimKeys = next.retiredClaimKeys
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

export function agentSessionStoreCacheChanges(
  before: AgentSessionStoreState,
  after: AgentSessionStoreState,
  writes: AgentSessionStoreRowWrites
) {
  return {
    senderIdentity: changesAgentSenderIdentity(before, after, writes),
    lineage:
      writes.records.remove.length > 0 ||
      writes.records.upsert.some(
        ([id]) =>
          !isDeepStrictEqual(
            before.records.get(id)?.conversationCommand,
            after.records.get(id)?.conversationCommand
          )
      ),
    deaths: writes.records.upsert.flatMap(([id]) => {
      const death = after.records.get(id)?.lease.deathEvidence
      return death && !isDeepStrictEqual(before.records.get(id)?.lease.deathEvidence, death)
        ? [id]
        : []
    })
  }
}
