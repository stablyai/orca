import { journalItemEchoFields, type JournalItemEcho } from './journal-item-echo'
import type {
  AgentJournalSubmission,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentJournalProducerLinkage,
  AgentJournalRowAttribution,
  AgentJournalTurnScope,
  AgentSessionJournalIdentity,
  AgentSessionJournalProviderHandle
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { journalItemOwnerFence } from './journal-item-provenance'
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
import {
  boundInlineText,
  boundRunningToolOutput,
  JOURNAL_DISPATCH_REASON_LIMITS
} from './journal-payload-bounds'
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
  options: AgentJournalRowAttribution & {
    echoOf?: JournalItemEcho['echoOf']
    fence: number
    ownerFence?: number
    executionOwner?: number
    observedAt?: number
    recovered?: true
  },
  revisions?: Map<string, number>
): RowBuilder<JournalItemRow> {
  return (seq, ts) =>
    buildJournalItemRow({
      state: state(),
      ...(typeof address === 'string' ? { itemId: address } : { identity: address }),
      body,
      ...journalItemEchoFields(options),
      seq,
      fence: options.fence,
      ownerFence: options.ownerFence,
      executionOwner: options.executionOwner,
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
    options?: AgentSessionExecutionOptions
  },
  /** Stamp queue links from consumption here so every handoff preserves them. */
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
    // Explicit null distinguishes no answered turn from older rows lacking the field.
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
    ...(input.state === 'pending' ? { turnScope: input.turnScope } : {}),
    ...(input.state === 'pending' && input.carries?.length ? { carries: [...input.carries] } : {})
  })
}

/** Bound provider error heads to preserve prefix-based classification; legacy readers still need their own bound. */
function boundedDispatchReason(input: ResolveDispatchInput): string | null {
  if (input.state === 'accepted' || input.state === 'pending' || !input.reason) {
    return null
  }
  return boundInlineText(input.reason, JOURNAL_DISPATCH_REASON_LIMITS).text
}

export function journalLifecycleBatchRowBuilder(
  state: () => JournalReducerState,
  settlementId: string,
  mutations: readonly JournalLifecycleMutationInput[],
  /** Each mutation owns producer linkage; whole-row stamping would misattribute mixed-agent batches. */
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
        revision,
        journalItemOwnerFence(current, resolved, {
          fence: options.fence,
          ownerFence: mutation.kind === 'item' ? mutation.ownerFence : undefined
        })
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
    echoOf?: JournalItemEcho['echoOf']
    state: JournalReducerState
    body: AgentJournalItemBody
    seq: number
    fence: number
    ownerFence?: number
    executionOwner?: number
    ts: number
    recovered?: true
    linkage?: AgentJournalProducerLinkage
    turnScope: AgentJournalTurnScope
    revisions?: Map<string, number>
  }
): JournalItemRow {
  const itemId = journalLifecycleMutationItemId(input)
  const resolved = input.state.aliases.get(itemId) ?? itemId
  // Recreated items must outrank tombstones or the reducer will discard them.
  const revision = nextJournalItemRevision(input.state, itemId, input.revisions)
  const body = boundRunningToolOutput(turnEndAfterStop(input.state, resolved, input.body))
  return {
    kind: 'item',
    ...journalItemEchoFields(input),
    itemId,
    revision,
    body,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts, [body]),
    ownerFence: journalItemOwnerFence(input.state, resolved, input),
    ...(input.executionOwner === undefined ? {} : { executionOwner: input.executionOwner }),
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
    // Rank above both live and tombstone revisions even if map-disjointness is later relaxed.
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
  source?: AgentJournalSubmission['source']
  options?: AgentSessionExecutionOptions
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
    // Sender identities belong to message bodies; persist only the source kind here.
    ...(input.source !== undefined ? { source: { kind: input.source.kind } } : {}),
    ...(input.options ? { options: input.options } : {})
  }
}
