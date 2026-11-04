import type { ExecutionInterruption } from './journal-execution-interruption'
import { journalWriteTurnScope } from './journal-write-turn-scope'
import {
  journalExecutionAddress,
  journalExecutionOriginForItem,
  type JournalExecutionOrigin
} from './journal-execution-item'
import { journalInputOrder } from './journal-input-order'
import type { JournalInputContext } from './journal-input-lineage'
import { journalItemEchoFields, type JournalItemEcho } from './journal-item-echo'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity,
  AgentSessionJournalProviderHandle
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  type AgentJournalSubmission,
  type AgentJournalItemBody,
  type AgentJournalProducerLinkage,
  type AgentJournalRowAttribution,
  journalRowSchemaVersion
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalItemExecutionFence, journalItemOwnerFence } from './journal-item-provenance'
import type { JournalReducerState } from './journal-reducer'
import type { JournalDispatchRow, JournalItemRow, JournalSubmissionRow } from './journal-row-schema'
import {
  boundInlineText,
  boundRunningToolOutput,
  JOURNAL_DISPATCH_REASON_LIMITS
} from './journal-payload-bounds'
import { assertSubmissionIdUnused } from './journal-write-guards'
import { turnEndAfterStop } from './journal-stop-turn-end'
import { nextJournalItemRevision } from './journal-item-revision'
import type { ResolveDispatchInput, JournalSubmissionInput } from './journal-store-contracts'
import {
  journalLifecycleMutationItemId,
  type JournalItemAddress
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

export function journalSubmissionRowBuilder(
  state: () => JournalReducerState,
  identity: Pick<AgentSessionJournalIdentity, 'providerHandle' | 'agent'>,
  input: JournalSubmissionInput,
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
      inputOrderContext: {
        source: { epoch: state().epoch, sequence: seq },
        basis: 'observed',
        cut: journalInputOrder(state()).lineage.at(seq)
      },
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

export { journalLifecycleBatchRowBuilder } from './journal-lifecycle-row'

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
    executionInterruption?: ExecutionInterruption
    executionOrigin?: JournalExecutionOrigin
    ts: number
    recovered?: true
    linkage?: AgentJournalProducerLinkage
    turnScope: AgentJournalTurnScope
    revisions?: Map<string, number>
  }
): JournalItemRow {
  const itemId = journalLifecycleMutationItemId(input)
  const address = journalExecutionAddress(
    input.state,
    { kind: input.itemId === undefined ? 'provider' : 'exact', itemId },
    input.body,
    input
  )
  const resolved = address.itemId ?? itemId
  // Recreated items must outrank tombstones or the reducer will discard them.
  const revision = nextJournalItemRevision(input.state, resolved, input.revisions)
  const body = boundRunningToolOutput(
    address.itemId === undefined
      ? input.body
      : turnEndAfterStop(
          input.state,
          resolved,
          input.body,
          input.executionOwner ??
            journalItemExecutionFence(input.state, resolved) ??
            input.ownerFence ??
            input.fence
        )
  )
  const executionOrigin =
    input.executionOrigin ??
    (input.itemId === undefined ? undefined : journalExecutionOriginForItem(input.state, itemId))
  return {
    kind: 'item',
    ...(input.executionInterruption ? { executionInterruption: input.executionInterruption } : {}),
    ...(executionOrigin ? { executionOrigin } : {}),
    ...journalItemEchoFields(input),
    itemId,
    revision,
    body,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts, [body]),
    ownerFence:
      address.itemId === undefined
        ? (input.ownerFence ?? input.fence)
        : journalItemOwnerFence(input.state, resolved, input),
    ...(input.executionOwner === undefined ? {} : { executionOwner: input.executionOwner }),
    ...(input.recovered ? { recovered: input.recovered } : {}),
    turnScope: journalWriteTurnScope(
      input.state,
      input.turnScope,
      input.executionOwner ?? input.ownerFence ?? input.fence,
      input.itemId !== undefined ? 'exact' : 'provider'
    ),
    ...agentJournalLinkageFields(input.linkage)
  }
}

export function buildJournalSubmissionRow(
  input: Omit<JournalSubmissionInput, 'source'> &
    Pick<AgentJournalSubmission, 'source'> & {
      state: JournalReducerState
      providerHandle: AgentSessionJournalProviderHandle
      seq: number
      ts: number
      inputOrderContext?: JournalInputContext
    }
): JournalSubmissionRow {
  return {
    kind: 'submission',
    ...(input.inputOrderContext ? { inputOrderContext: input.inputOrderContext } : {}),
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
