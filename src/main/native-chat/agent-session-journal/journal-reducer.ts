// THE reducer. One implementation folds rows into the render model, and both
// the live append path and replay call it — a live-only shortcut is how a
// reconnect starts disagreeing with the screen it replaced.
//
// Rules: highest revision wins, a tombstone removes, a late lower revision is
// dropped rather than resurrecting stale content, and ordering is by the
// position (sequence, then place in the row) of the write that CREATED an item
// (a later revision updates the body, it does not move the bubble) — except a
// queued message, which sits where its handover put it, and a rejected one, which
// sits where it was rejected. Producer linkage is likewise the creating write's: a
// revision naming no producer keeps it, one naming any replaces it.

import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { journalBatchMutationProducer, journalRenderItem } from './journal-render-item'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import { removeJournalItem, statedOrDerivedTurnScope, upsertJournalItem } from './journal-item-fold'
import { journalItemRevisionIsStale } from './journal-item-revision'
import { isJournalStopOrResumeRow, type JournalRow } from './journal-row-schema'
import { acceptSubmissionFromProviderItem, applyJournalSubmission } from './journal-submission-fold'
import { applyJournalDispatchRow } from './journal-dispatch-reducer'
import { isWriteFailureSubmission } from '../../../shared/structured-agent-session-dispatch-rejection'
import { projectJournalStopNote } from './journal-stop-note-projection'
import {
  createJournalQueuePauseMarks,
  foldJournalQueuePauseMark,
  type JournalQueuePauseMarks
} from './queued-message-pause'

export const MAX_JOURNAL_APPLIED_SETTLEMENT_IDS = 4_096

export type JournalReducerState = {
  sessionId: string
  epoch: string
  lastSequence: number
  lastActivityAt: number
  /** Lowest sequence still individually replayable; rows below it were compacted. */
  oldestSequence: number
  highestFence: number
  items: Map<string, AgentJournalRenderItem>
  /** Fence of the writer that created each item: the generation a running turn belongs to. */
  itemFences: Map<string, number>
  /** Revision of a removed item, so a late lower revision cannot resurrect it. */
  tombstones: Map<string, number>
  submissions: Map<string, AgentJournalSubmission>
  receipts: Map<string, AgentJournalAcceptanceReceipt>
  /** Provider item id → the submission slot that adopted it. Stops an accepted
   *  echo from appending a second copy of the user's own message. */
  aliases: Map<string, string>
  appliedSettlementIds: Set<string>
  /** Scope for rows stored without one; rebuilt by replay, never persisted. */
  derivedTurnScope: JournalDerivedTurnScope
  /** The submission row of the latest turn the provider accepted, whoever sent it; 0 when none.
   *  Kept as it folds so the queue's pause reads it in O(1). */
  latestAcceptedTurnSequence: number
  /** The latest person's Stop event and Resume, what the queue's pause is derived from. */
  queuePauseMarks: JournalQueuePauseMarks
}

export function createJournalReducerState(sessionId: string, epoch: string): JournalReducerState {
  return {
    sessionId,
    epoch,
    lastSequence: 0,
    lastActivityAt: 0,
    oldestSequence: 1,
    highestFence: 0,
    items: new Map(),
    itemFences: new Map(),
    tombstones: new Map(),
    submissions: new Map(),
    receipts: new Map(),
    aliases: new Map(),
    appliedSettlementIds: new Set(),
    derivedTurnScope: new JournalDerivedTurnScope(),
    latestAcceptedTurnSequence: 0,
    queuePauseMarks: createJournalQueuePauseMarks()
  }
}

export function applyJournalRow(state: JournalReducerState, row: JournalRow): void {
  state.lastSequence = Math.max(state.lastSequence, row.seq)
  state.highestFence = Math.max(state.highestFence, row.fence)
  if (row.kind === 'epoch') {
    return
  }
  state.lastActivityAt = Math.max(state.lastActivityAt, row.ts)
  if (row.kind === 'item') {
    if (journalItemRevisionIsStale(state, row.itemId, row.revision)) {
      return
    }
    const itemId = resolveJournalItemId(state, row.itemId, row.body)
    acceptSubmissionFromProviderItem(state, row.itemId, itemId, row)
    upsertJournalItem(
      state,
      itemId,
      row.revision,
      journalRenderItem(itemId, row.revision, row.body, row, statedOrDerivedTurnScope(state, row)),
      row.fence
    )
    return
  }
  if (isJournalStopOrResumeRow(row)) {
    foldJournalQueuePauseMark(state.queuePauseMarks, row)
    return
  }
  if (row.kind === 'tombstone') {
    removeJournalItem(state, resolveItemId(state, row.itemId), row.revision)
    return
  }
  if (row.kind === 'lifecycle-batch') {
    if (state.appliedSettlementIds.has(row.settlementId)) {
      return
    }
    for (const [sequenceIndex, mutation] of row.mutations.entries()) {
      if (mutation.kind === 'item') {
        if (journalItemRevisionIsStale(state, mutation.itemId, mutation.revision)) {
          continue
        }
        const { revision, body } = mutation
        const itemId = resolveJournalItemId(state, mutation.itemId, body)
        acceptSubmissionFromProviderItem(state, mutation.itemId, itemId, row)
        const producer = journalBatchMutationProducer(row, mutation)
        const scope = statedOrDerivedTurnScope(state, mutation)
        const item = journalRenderItem(itemId, revision, body, row, scope, producer, sequenceIndex)
        upsertJournalItem(state, itemId, revision, item, row.fence)
      } else {
        removeJournalItem(state, resolveItemId(state, mutation.itemId), mutation.revision)
      }
    }
    rememberAppliedSettlementId(state, row.settlementId)
    return
  }
  if (row.kind === 'submission') {
    applyJournalSubmission(state, row)
    return
  }
  applyJournalDispatchRow(state, row)
}

export function rememberAppliedSettlementId(
  state: JournalReducerState,
  settlementId: string
): void {
  state.appliedSettlementIds.add(settlementId)
  while (state.appliedSettlementIds.size > MAX_JOURNAL_APPLIED_SETTLEMENT_IDS) {
    const oldest = state.appliedSettlementIds.values().next().value
    if (oldest === undefined) {
      return
    }
    state.appliedSettlementIds.delete(oldest)
  }
}

export function resolveJournalItemId(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string {
  const aliased = state.aliases.get(itemId)
  if (aliased) {
    return aliased
  }
  const submissionId = journalEchoClaimant(state, itemId, body)
  if (!submissionId) {
    return itemId
  }
  state.aliases.set(itemId, submissionId)
  return submissionId
}

/** A user message the provider wrote: the only item a submission's echo can be. */
export function isProviderUserMessageEcho(
  itemId: string,
  body: AgentJournalRenderItem['body']
): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return (
    body.kind === 'message' &&
    body.role === 'user' &&
    identity !== null &&
    identity.provider !== 'orca'
  )
}

/** The submission item a provider's echo of a user message would fold into, read without
 *  claiming it; null when the item is not such an echo, or no submission may claim it. */
export function journalEchoClaimant(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string | null {
  if (!body || !isProviderUserMessageEcho(itemId, body)) {
    return null
  }
  const fingerprint = agentSessionSendBodyFingerprint(state.sessionId, body)
  // Exact payload plus queue order preserves repeated identical sends one-for-one.
  // A submission an echo may not claim is one that says the message never reached
  // the provider, so an item resembling it is somebody else's. That is `rejected`
  // now — and, in journals written before this state moved, an `unknown` carrying
  // the transport marker. Replaying an older journal must not let such a row alias
  // the echo of a later, genuinely delivered resend of the same text.
  const submission = [...state.submissions.values()]
    .sort((left, right) => left.submittedAt - right.submittedAt)
    .find(
      (candidate) =>
        candidate.dispatchState !== 'rejected' &&
        !isWriteFailureSubmission(candidate) &&
        candidate.payloadFingerprint === fingerprint &&
        state.items.get(agentJournalSubmissionKey(candidate.clientMessageId))?.revision === 0
    )
  return submission ? agentJournalSubmissionKey(submission.clientMessageId) : null
}

function resolveItemId(state: JournalReducerState, itemId: string): string {
  return state.aliases.get(itemId) ?? itemId
}

/** Project the folded state into the client-facing snapshot. */
export function renderJournalState(state: JournalReducerState): AgentJournalSnapshot {
  // The journal position is the sole ordering key; map insertion order is not,
  // because a re-created item re-enters the map after the items that followed it.
  const items = [...state.items.values()]
    .map((item) => projectJournalStopNote(item, state.items))
    .sort(compareAgentJournalItems)
  return {
    sessionId: state.sessionId,
    cursor: { epoch: state.epoch, sequence: state.lastSequence },
    items,
    submissions: [...state.submissions.values()].sort((a, b) => a.submittedAt - b.submittedAt)
  }
}
