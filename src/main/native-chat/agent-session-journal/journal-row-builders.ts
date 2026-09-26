import type {
  AgentJournalDispatchState,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalProducerLinkage,
  AgentJournalRowAttribution,
  AgentJournalTurnScope,
  AgentSessionProviderHandle
} from '../../../shared/agent-session-journal-types'
import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'
import {
  agentJournalLinkageFields,
  namesAgentJournalProducer
} from '../../../shared/agent-session-journal-producer'
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
import { boundInlineText, DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import type { ResolveDispatchInput } from './journal-store-contracts'

type RowBuilder<T> = (seq: number, ts: number) => T

export function journalItemRowBuilder(
  state: () => JournalReducerState,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: AgentJournalRowAttribution & { fence: number; observedAt?: number; recovered?: true }
): RowBuilder<JournalItemRow> {
  return (seq, ts) =>
    buildJournalItemRow({
      state: state(),
      identity,
      body,
      seq,
      fence: options.fence,
      ts: options.observedAt ?? ts,
      recovered: options.recovered,
      linkage: options,
      turnScope: options.turnScope
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
    handoverRecorded?: true
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
    input.state === 'accepted' && input.providerIdentity
      ? agentJournalItemKey(input.providerIdentity)
      : null
  return (seq, ts) =>
    buildJournalDispatchRow({
      state: state(),
      clientMessageId: input.clientMessageId,
      dispatchState: input.state,
      providerItemId,
      reason: boundedDispatchReason(input),
      seq,
      fence: input.fence,
      ts,
      recovered: input.recovered,
      ...(input.state === 'pending' ? { turnScope: input.turnScope } : {})
    })
}

/** `reason` is the only unbounded field written by Orca's own code: a provider error is
 *  arbitrary text, and a multi-megabyte one reached the row verbatim. Bounded head-first,
 *  because `dispatchRejectionWasTransportWriteFailure` prefix-matches the value. Rows
 *  written before this keep their full text, so readers still meet unbounded ones. */
function boundedDispatchReason(input: ResolveDispatchInput): string | null {
  if (input.state === 'accepted' || input.state === 'pending' || !input.reason) {
    return null
  }
  return boundInlineText(input.reason, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
}

export type JournalLifecycleMutationInput =
  | {
      kind: 'item'
      identity: AgentJournalItemIdentity
      body: AgentJournalItemBody
      /** Who wrote the row. Absent ⇒ the session's own agent on a first write,
       *  and the row's existing producer on a revision. */
      linkage?: AgentJournalProducerLinkage
      /** Which turn the row belongs to. Kept from the write that creates the row. */
      turnScope: AgentJournalTurnScope
    }
  | { kind: 'tombstone'; identity: AgentJournalItemIdentity }

/** An item mutation from a writer that knows who produced the row. Needed
 *  because a batch can CREATE a row — a Codex child's prompt, or its item
 *  settled before any checkpoint landed — and one batch can mix producers.
 *  The session's own rows carry no key at all: absence is the claim. */
export function journalLifecycleItemMutation(
  attribution: AgentJournalRowAttribution,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): JournalLifecycleMutationInput {
  const { turnScope } = attribution
  return namesAgentJournalProducer(attribution)
    ? { kind: 'item', identity, body, turnScope, linkage: agentJournalLinkageFields(attribution) }
    : { kind: 'item', identity, body, turnScope }
}

/** The persisted form of one mutation, shared with the partitioner's size probe
 *  so a chunk is measured with the linkage it will actually carry. */
export function journalLifecycleMutationRow(
  mutation: JournalLifecycleMutationInput,
  itemId: string,
  revision: number
): JournalLifecycleMutation {
  return mutation.kind === 'item'
    ? {
        kind: 'item',
        itemId,
        revision,
        body: mutation.body,
        turnScope: mutation.turnScope,
        ...agentJournalLinkageFields(mutation.linkage)
      }
    : { kind: 'tombstone', itemId, revision }
}

export function journalLifecycleBatchRowBuilder(
  state: () => JournalReducerState,
  settlementId: string,
  mutations: readonly JournalLifecycleMutationInput[],
  /** No ROW-level producer: one batch row covers N mutations, so a row-level
   *  producer would stamp whoever opened the batch onto every one of them.
   *  An item mutation names its own, or none to keep the row's existing one.
   *  The reducer still reads row-level linkage as the fallback for a mutation
   *  that names none, because a row may come from a host that wrote one. */
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
      return journalLifecycleMutationRow(mutation, itemId, revision)
    })
    const row: JournalLifecycleBatchRow = {
      kind: 'lifecycle-batch',
      settlementId,
      mutations: built,
      ...journalRowBase(
        current.epoch,
        seq,
        options.fence,
        ts,
        built.flatMap((mutation) => (mutation.kind === 'item' ? [mutation.body] : []))
      ),
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
  ts: number,
  bodies: readonly { kind: string }[] = []
): { v: number; epoch: string; seq: number; fence: number; ts: number } {
  return { v: journalRowSchemaVersion(bodies), epoch, seq, fence, ts }
}

export function buildJournalItemRow(input: {
  state: JournalReducerState
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  seq: number
  fence: number
  ts: number
  recovered?: true
  linkage?: AgentJournalProducerLinkage
  turnScope: AgentJournalTurnScope
}): JournalItemRow {
  const itemId = agentJournalItemKey(input.identity)
  const resolved = input.state.aliases.get(itemId) ?? itemId
  // A tombstoned row keeps its revision in `tombstones`, and the reducer drops
  // any item at or below it — so a re-add has to outrank the tombstone too.
  const revision =
    Math.max(
      input.state.items.get(resolved)?.revision ?? 0,
      input.state.tombstones.get(resolved) ?? 0
    ) + 1
  return {
    kind: 'item',
    itemId,
    revision,
    body: input.body,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts, [input.body]),
    ...(input.recovered ? { recovered: input.recovered } : {}),
    turnScope: input.turnScope,
    ...agentJournalLinkageFields(input.linkage)
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
    // Symmetric with the item builder: `upsertItem` clearing the tombstone on a
    // re-add is what keeps the two maps disjoint, and that invariant lives in the
    // reducer. Outranking both here means a repeat removal cannot be dropped as a
    // stale revision if it ever stops holding.
    revision:
      Math.max(
        input.state.items.get(resolved)?.revision ?? 0,
        input.state.tombstones.get(resolved) ?? 0
      ) + 1,
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
  handoverRecorded?: true
}): JournalSubmissionRow {
  return {
    kind: 'submission',
    clientMessageId: input.clientMessageId,
    payloadFingerprint: input.payloadFingerprint,
    providerHandle: input.providerHandle,
    body: input.body,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts),
    ...(input.handoverRecorded ? { handoverRecorded: true } : {})
  }
}

export function buildJournalDispatchRow(input: {
  state: JournalReducerState
  clientMessageId: string
  dispatchState: AgentJournalDispatchState
  providerItemId: string | null
  reason: string | null
  seq: number
  fence: number
  ts: number
  recovered?: true
  turnScope?: AgentJournalTurnScope
}): JournalDispatchRow {
  return {
    kind: 'dispatch',
    clientMessageId: input.clientMessageId,
    state: input.dispatchState,
    providerItemId: input.providerItemId,
    reason: input.reason,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts),
    ...(input.recovered ? { recovered: input.recovered } : {}),
    ...(input.turnScope ? { turnScope: input.turnScope } : {})
  }
}
