import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalProducerLinkage,
  AgentJournalRowAttribution,
  AgentJournalTurnScope,
  AgentSessionJournalIdentity,
  AgentSessionJournalProviderHandle
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionMessageSource } from '../../../shared/agent-session-message-source'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
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
import { assertSubmissionIdUnused } from './journal-write-guards'
import { turnEndAfterStop } from './journal-stop-turn-end'
import { nextJournalItemRevision } from './journal-item-revision'
import type { ResolveDispatchInput } from './journal-store-contracts'
import {
  journalLifecycleMutationItemId,
  journalLifecycleMutationRow,
  type JournalItemAddress,
  type JournalLifecycleMutationInput
} from './journal-lifecycle-mutation'
export {
  journalLifecycleItemMutation,
  journalLifecycleMutationItemId,
  journalLifecycleMutationRow,
  type JournalLifecycleMutationInput,
  type JournalLifecycleIdentityMutationInput
} from './journal-lifecycle-mutation'

type RowBuilder<T> = (seq: number, ts: number) => T

export function journalItemRowBuilder(
  state: () => JournalReducerState,
  address: AgentJournalItemIdentity | string,
  body: AgentJournalItemBody,
  options: AgentJournalRowAttribution & { fence: number; observedAt?: number; recovered?: true },
  revisions?: Map<string, number>
): RowBuilder<JournalItemRow> {
  return (seq, ts) =>
    buildJournalItemRow({
      state: state(),
      ...(typeof address === 'string' ? { itemId: address } : { identity: address }),
      body,
      seq,
      fence: options.fence,
      ts: options.observedAt ?? ts,
      recovered: options.recovered,
      linkage: options,
      turnScope: options.turnScope,
      revisions
    })
}

export function journalTombstoneRowBuilder(
  state: () => JournalReducerState,
  itemId: string,
  fence: number,
  revisions?: Map<string, number>
): RowBuilder<JournalTombstoneRow> {
  return (seq, ts) =>
    buildJournalTombstoneRow({ state: state(), itemId, seq, fence, ts, revisions })
}

export function journalSubmissionRowBuilder(
  state: () => JournalReducerState,
  identity: Pick<AgentSessionJournalIdentity, 'providerHandle' | 'agent'>,
  input: {
    clientMessageId: string
    payloadFingerprint: string
    body: AgentJournalMessageItem
    fence: number
    handoverRecorded?: true
    queuedMessageId?: string
    origin?: 'client' | 'host'
  },
  /** Present when the append hands off a queued draft: the row names that draft, stamped here
   *  from the consume itself so no hand-off path can leave the link off. */
  consume?: { messageId: string }
): RowBuilder<JournalSubmissionRow> {
  return (seq, ts) => {
    assertSubmissionIdUnused(state().submissions, input.clientMessageId)
    if (consume && (input.queuedMessageId ?? consume.messageId) !== consume.messageId) {
      throw new Error(`submission ${input.clientMessageId} names a draft it does not consume`)
    }
    const queuedMessageId = consume?.messageId ?? input.queuedMessageId
    return buildJournalSubmissionRow({
      state: state(),
      providerHandle: agentSessionJournalProviderHandle(identity),
      ...input,
      ...(queuedMessageId !== undefined ? { queuedMessageId } : {}),
      seq,
      ts
    })
  }
}

export function journalDispatchRowBuilder(
  state: () => JournalReducerState,
  input: ResolveDispatchInput
): RowBuilder<JournalDispatchRow> {
  const providerItemId =
    input.state === 'accepted' && input.providerIdentity
      ? agentJournalItemKey(input.providerIdentity)
      : null
  // The only dispatch-row builder: its input type is what makes a rejected row carry its fact.
  return (seq, ts) => ({
    kind: 'dispatch',
    clientMessageId: input.clientMessageId,
    state: input.state,
    providerItemId,
    reason: boundedDispatchReason(input),
    ...(input.state === 'rejected' ? { rejection: input.rejection } : {}),
    ...(input.state === 'rejected' && input.keptAsQueuedMessageId !== undefined
      ? { keptAsQueuedMessageId: input.keptAsQueuedMessageId }
      : {}),
    // Every rejection states its turn, null for none, so a reader tells it from an older row.
    ...(input.state === 'rejected'
      ? {
          answeredInTurn: input.answeredInTurn
            ? {
                turnItemId: agentJournalItemKey(input.answeredInTurn.turn),
                via: input.answeredInTurn.via
              }
            : null
        }
      : {}),
    ...journalRowBase(state().epoch, seq, input.fence, ts),
    ...(input.recovered ? { recovered: input.recovered } : {}),
    ...(input.state === 'pending' ? { turnScope: input.turnScope } : {})
  })
}

/** `reason` is the only unbounded field written by Orca's own code: a provider error is
 *  arbitrary text, and a multi-megabyte one reached the row verbatim. Bounded head-first,
 *  because `isWriteFailureSubmission` prefix-matches the value. Rows
 *  written before this keep their full text, so readers still meet unbounded ones. */
function boundedDispatchReason(input: ResolveDispatchInput): string | null {
  if (input.state === 'accepted' || input.state === 'pending' || !input.reason) {
    return null
  }
  return boundInlineText(input.reason, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
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
  options: { fence: number; recovered?: true },
  revisions?: Map<string, number>
): RowBuilder<JournalLifecycleBatchRow> {
  return (seq, ts) => {
    if (mutations.length === 0 || mutations.length > MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS) {
      throw new Error('journal_lifecycle_batch_mutation_bound_exceeded')
    }
    const current = state()
    const runningRevisions = revisions ?? new Map<string, number>()
    const built: JournalLifecycleMutation[] = mutations.map((mutation) => {
      const itemId = journalLifecycleMutationItemId(mutation)
      const resolved = current.aliases.get(itemId) ?? itemId
      const revision = nextJournalItemRevision(current, itemId, runningRevisions)
      return journalLifecycleMutationRow(
        mutation.kind === 'item'
          ? { ...mutation, body: turnEndAfterStop(current, resolved, mutation.body) }
          : mutation,
        itemId,
        revision
      )
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

export function buildJournalItemRow(
  input: JournalItemAddress & {
    state: JournalReducerState
    body: AgentJournalItemBody
    seq: number
    fence: number
    ts: number
    recovered?: true
    linkage?: AgentJournalProducerLinkage
    turnScope: AgentJournalTurnScope
    revisions?: Map<string, number>
  }
): JournalItemRow {
  const itemId = journalLifecycleMutationItemId(input)
  const resolved = input.state.aliases.get(itemId) ?? itemId
  // A tombstoned row keeps its revision in `tombstones`, and the reducer drops
  // any item at or below it — so a re-add has to outrank the tombstone too.
  const revision = nextJournalItemRevision(input.state, itemId, input.revisions)
  const body = turnEndAfterStop(input.state, resolved, input.body)
  return {
    kind: 'item',
    itemId,
    revision,
    body,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts, [body]),
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
  revisions?: Map<string, number>
}): JournalTombstoneRow {
  return {
    kind: 'tombstone',
    itemId: input.itemId,
    // Symmetric with the item builder: `upsertItem` clearing the tombstone on a
    // re-add is what keeps the two maps disjoint, and that invariant lives in the
    // reducer. Outranking both here means a repeat removal cannot be dropped as a
    // stale revision if it ever stops holding.
    revision: nextJournalItemRevision(input.state, input.itemId, input.revisions),
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts)
  }
}

export function buildJournalSubmissionRow(input: {
  state: JournalReducerState
  clientMessageId: string
  payloadFingerprint: string
  providerHandle: AgentSessionJournalProviderHandle
  body: AgentJournalMessageItem
  seq: number
  fence: number
  ts: number
  handoverRecorded?: true
  queuedMessageId?: string
  origin?: 'client' | 'host'
  source?: Pick<AgentSessionMessageSource, 'kind'>
}): JournalSubmissionRow {
  return {
    kind: 'submission',
    clientMessageId: input.clientMessageId,
    payloadFingerprint: input.payloadFingerprint,
    providerHandle: input.providerHandle,
    body: input.body,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts),
    ...(input.handoverRecorded ? { handoverRecorded: true } : {}),
    ...(input.queuedMessageId !== undefined ? { queuedMessageId: input.queuedMessageId } : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    // The kind only; who the senders are is on the message body.
    ...(input.source !== undefined ? { source: { kind: input.source.kind } } : {})
  }
}
