import type {
  AgentJournalDispatchState,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionProviderHandle
} from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import type {
  JournalDispatchRow,
  JournalItemRow,
  JournalLifecycleBatchRow,
  JournalLifecycleMutation,
  JournalSubmissionRow,
  JournalTombstoneRow
} from './journal-row-schema'
import {
  MAX_JOURNAL_LIFECYCLE_BATCH_BYTES,
  MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS
} from './journal-row-schema'
import type { ResolveDispatchInput } from './journal-store-contracts'

type RowBuilder<T> = (seq: number, ts: number) => T

export function journalItemRowBuilder(
  state: () => JournalReducerState,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: { fence: number; observedAt?: number; recovered?: true }
): RowBuilder<JournalItemRow> {
  return (seq, ts) =>
    buildJournalItemRow({
      state: state(),
      identity,
      body,
      seq,
      fence: options.fence,
      ts: options.observedAt ?? ts,
      recovered: options.recovered
    })
}

export function journalTombstoneRowBuilder(
  state: () => JournalReducerState,
  itemId: string,
  fence: number
): RowBuilder<JournalTombstoneRow> {
  return (seq, ts) => buildJournalTombstoneRow({ state: state(), itemId, seq, fence, ts })
}

export function journalSubmissionRowBuilder(
  state: () => JournalReducerState,
  providerHandle: AgentSessionProviderHandle,
  input: {
    clientMessageId: string
    payloadFingerprint: string
    body: AgentJournalMessageItem
    fence: number
  }
): RowBuilder<JournalSubmissionRow> {
  return (seq, ts) =>
    buildJournalSubmissionRow({ state: state(), providerHandle, ...input, seq, ts })
}

export function journalDispatchRowBuilder(
  state: () => JournalReducerState,
  input: ResolveDispatchInput
): RowBuilder<JournalDispatchRow> {
  const providerItemId =
    input.state === 'accepted' ? agentJournalItemKey(input.providerIdentity) : null
  return (seq, ts) =>
    buildJournalDispatchRow({
      state: state(),
      clientMessageId: input.clientMessageId,
      dispatchState: input.state,
      providerItemId,
      reason: input.state === 'accepted' ? null : (input.reason ?? null),
      seq,
      fence: input.fence,
      ts,
      recovered: input.recovered
    })
}

export type JournalLifecycleMutationInput =
  | { kind: 'item'; identity: AgentJournalItemIdentity; body: AgentJournalItemBody }
  | { kind: 'tombstone'; identity: AgentJournalItemIdentity }

export function journalLifecycleBatchRowBuilder(
  state: () => JournalReducerState,
  settlementId: string,
  mutations: readonly JournalLifecycleMutationInput[],
  options: { fence: number; recovered?: true }
): RowBuilder<JournalLifecycleBatchRow> {
  return (seq, ts) => {
    if (mutations.length === 0 || mutations.length > MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS) {
      throw new Error('journal_lifecycle_batch_mutation_bound_exceeded')
    }
    const current = state()
    const revisions = new Map<string, number>()
    const built: JournalLifecycleMutation[] = mutations.map((mutation) => {
      const itemId = agentJournalItemKey(mutation.identity)
      const resolved = current.aliases.get(itemId) ?? itemId
      const revision =
        (revisions.get(resolved) ??
          Math.max(
            current.items.get(resolved)?.revision ?? 0,
            current.tombstones.get(resolved) ?? 0
          )) + 1
      revisions.set(resolved, revision)
      return mutation.kind === 'item'
        ? { kind: 'item', itemId, revision, body: mutation.body }
        : { kind: 'tombstone', itemId, revision }
    })
    const row: JournalLifecycleBatchRow = {
      kind: 'lifecycle-batch',
      settlementId,
      mutations: built,
      ...journalRowBase(current.epoch, seq, options.fence, ts),
      ...(options.recovered ? { recovered: options.recovered } : {})
    }
    if (Buffer.byteLength(JSON.stringify(row), 'utf8') + 1 > MAX_JOURNAL_LIFECYCLE_BATCH_BYTES) {
      throw new Error('journal_lifecycle_batch_byte_bound_exceeded')
    }
    return row
  }
}

export function journalRowBase(
  epoch: string,
  seq: number,
  fence: number,
  ts: number
): { v: number; epoch: string; seq: number; fence: number; ts: number } {
  return { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch, seq, fence, ts }
}

export function buildJournalItemRow(input: {
  state: JournalReducerState
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  seq: number
  fence: number
  ts: number
  recovered?: true
}): JournalItemRow {
  const itemId = agentJournalItemKey(input.identity)
  const resolved = input.state.aliases.get(itemId) ?? itemId
  const revision = (input.state.items.get(resolved)?.revision ?? 0) + 1
  return {
    kind: 'item',
    itemId,
    revision,
    body: input.body,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts),
    ...(input.recovered ? { recovered: input.recovered } : {})
  }
}

export function buildJournalTombstoneRow(input: {
  state: JournalReducerState
  itemId: string
  seq: number
  fence: number
  ts: number
}): JournalTombstoneRow {
  const resolved = input.state.aliases.get(input.itemId) ?? input.itemId
  return {
    kind: 'tombstone',
    itemId: input.itemId,
    revision: (input.state.items.get(resolved)?.revision ?? 0) + 1,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts)
  }
}

export function buildJournalSubmissionRow(input: {
  state: JournalReducerState
  clientMessageId: string
  payloadFingerprint: string
  providerHandle: AgentSessionProviderHandle
  body: AgentJournalMessageItem
  seq: number
  fence: number
  ts: number
}): JournalSubmissionRow {
  return {
    kind: 'submission',
    clientMessageId: input.clientMessageId,
    payloadFingerprint: input.payloadFingerprint,
    providerHandle: input.providerHandle,
    body: input.body,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts)
  }
}

export function buildJournalDispatchRow(input: {
  state: JournalReducerState
  clientMessageId: string
  dispatchState: Exclude<AgentJournalDispatchState, 'pending'>
  providerItemId: string | null
  reason: string | null
  seq: number
  fence: number
  ts: number
  recovered?: true
}): JournalDispatchRow {
  return {
    kind: 'dispatch',
    clientMessageId: input.clientMessageId,
    state: input.dispatchState,
    providerItemId: input.providerItemId,
    reason: input.reason,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts),
    ...(input.recovered ? { recovered: input.recovered } : {})
  }
}
