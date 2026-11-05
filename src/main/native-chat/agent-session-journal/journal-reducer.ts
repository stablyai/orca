import { finishJournalSteps } from './journal-reconstruction-steps'
import { journalContextCursor } from './journal-context-cursor'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import {
  foldJournalInputObligations,
  journalInputPresentationMember
} from './journal-input-obligations'
import { resolveJournalItemId } from './journal-item-echo'
import { journalInputOrder } from './journal-input-order'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalHistoryOrigin } from './journal-history-origin'
import { journalBatchMutationProducer, journalRenderItem } from './journal-render-item'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import { removeJournalItem, statedOrDerivedTurnScope, upsertJournalItem } from './journal-item-fold'
import { journalItemRevisionIsStale } from './journal-item-revision'
import { observeJournalProviderActivity } from './journal-provider-activity'
import { isJournalStopOrResumeRow, type JournalRow } from './journal-row-schema'
import {
  acceptSubmissionFromProviderItemSteps,
  applyJournalSubmission
} from './journal-submission-fold'
import { applyJournalDispatchRow } from './journal-dispatch-reducer'

import { projectJournalStopNote } from './journal-stop-note-projection'
import { journalItemExecutionFence } from './journal-item-provenance'
import { retireRewoundJournalSubmissionSteps } from './journal-rewind-submission-retirement'

import { foldJournalQueuePauseMark } from './queued-message-pause'
import { foldJournalQueueRowSteps } from './journal-queue-fold'
export {
  resolveJournalItemId,
  journalEchoClaimant,
  isProviderUserMessageEcho
} from './journal-item-echo'
// Live append and replay share this fold. Revisions change content, preserving creation position
// and unspecified producer linkage; queued/rejected submissions use their handoff/settlement positions.

export const MAX_JOURNAL_APPLIED_SETTLEMENT_IDS = 4_096

export { createJournalReducerState, type JournalReducerState } from './journal-reducer-state'
import type { JournalReducerState } from './journal-reducer-state'

export function applyJournalRow(
  state: JournalReducerState,
  row: JournalRow,
  savedAt = row.ts
): void {
  finishJournalSteps(applyJournalRowSteps(state, row, savedAt))
}
export function* applyJournalRowSteps(
  state: JournalReducerState,
  row: JournalRow,
  savedAt = row.ts
): Generator<void> {
  const order = journalInputOrder(state)
  yield* order.prepareRowSteps(state, row)
  const dispatchApplies =
    row.kind !== 'dispatch' || journalDispatchRowApplies(state.submissions.get(row.clientMessageId))
  journalInputOrder(state).beforeRow(state, row)
  yield* applyJournalRowFactsSteps(state, row, savedAt)
  yield* foldJournalQueueRowSteps(state, row)
  foldJournalInputObligations(state, row, dispatchApplies)
  journalInputOrder(state).afterRow(state, row)
}

/** Marker 5 freezes the common-field interpretation that its outcome tail was written over. */
export function applyMarker5JournalRow(
  state: JournalReducerState,
  row: JournalRow,
  savedAt = row.ts
): void {
  finishJournalSteps(applyMarker5JournalRowSteps(state, row, savedAt))
}
export function* applyMarker5JournalRowSteps(
  state: JournalReducerState,
  row: JournalRow,
  savedAt = row.ts
): Generator<void> {
  yield* journalInputOrder(state).prepareRowSteps(state, row)
  journalInputOrder(state).beforeRow(state, row)
  yield* applyJournalRowFactsSteps(state, row, savedAt, true)
  yield* foldJournalQueueRowSteps(state, row, true)
  journalInputOrder(state).afterRow(state, row)
}

function* applyJournalRowFactsSteps(
  state: JournalReducerState,
  row: JournalRow,
  savedAt: number,
  marker5 = false
): Generator<void> {
  state.lastSequence = Math.max(state.lastSequence, row.seq)
  state.highestFence = Math.max(state.highestFence, row.fence)
  if (row.kind === 'epoch') {
    if (!marker5) {
      state.contextBoundary = row.seq
      state.derivedTurnScope = new JournalDerivedTurnScope()
    }
    state.historyOrigin = journalHistoryOrigin(row)
    return
  }
  // Queued cards cannot extend working status or postpone idle sweeps.
  if (row.kind === 'queue') {
    return
  }
  state.lastActivityAt = Math.max(state.lastActivityAt, row.ts)
  if (row.kind === 'item') {
    if (journalItemRevisionIsStale(state, row.itemId, row.revision)) {
      return
    }
    if (!state.itemEchoes.has(row.itemId) && Object.hasOwn(row, 'echoOf')) {
      state.itemEchoes.set(row.itemId, row.echoOf)
    }
    const itemId = resolveJournalItemId(state, row.itemId, row.body, marker5)
    if (!state.itemEchoes.has(row.itemId)) {
      yield* acceptSubmissionFromProviderItemSteps(state, row.itemId, itemId, row)
    }
    upsertJournalItem(
      state,
      itemId,
      row.revision,
      journalRenderItem(itemId, row.revision, row.body, row, statedOrDerivedTurnScope(state, row)),
      { fence: row.fence, ownerFence: row.ownerFence, executionOwner: row.executionOwner }
    )
    const fence = journalItemExecutionFence(state, itemId) ?? row.fence
    observeJournalProviderActivity(state, row, row.itemId, row.body, savedAt, fence)
    return
  }
  if (isJournalStopOrResumeRow(row)) {
    foldJournalQueuePauseMark(state.queuePauseMarks, row)
    return
  }
  if (row.kind === 'tombstone') {
    removeJournalItem(state, resolveItemId(state, row.itemId), row.revision)
    if (row.retireSubmission === true) {
      yield* retireRewoundJournalSubmissionSteps(state, row.itemId)
      const identity = parseAgentJournalItemKey(row.itemId)
      if (marker5 && identity?.provider === 'orca') {
        state.submissions.delete(identity.clientMessageId)
        state.receipts.delete(identity.clientMessageId)
      }
    }
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
        if (!state.itemEchoes.has(mutation.itemId) && Object.hasOwn(mutation, 'echoOf')) {
          state.itemEchoes.set(mutation.itemId, mutation.echoOf)
        }
        const { revision, body } = mutation
        const itemId = resolveJournalItemId(state, mutation.itemId, body, marker5)
        if (!state.itemEchoes.has(mutation.itemId)) {
          yield* acceptSubmissionFromProviderItemSteps(state, mutation.itemId, itemId, row)
        }
        const producer = journalBatchMutationProducer(row, mutation)
        const scope = statedOrDerivedTurnScope(state, mutation)
        const item = journalRenderItem(itemId, revision, body, row, scope, producer, sequenceIndex)
        item.observedAt = mutation.observedAt ?? row.ts
        upsertJournalItem(state, itemId, revision, item, {
          fence: row.fence,
          ownerFence: mutation.ownerFence
        })
        const fence = journalItemExecutionFence(state, itemId) ?? row.fence
        observeJournalProviderActivity(state, row, mutation.itemId, body, savedAt, fence)
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

export function renderJournalItems(state: JournalReducerState): AgentJournalSnapshot['items'] {
  // Map insertion order changes on recreation; journal position alone orders the timeline.
  return [...state.items.values()]
    .filter((item) => journalInputPresentationMember(state, item.itemId))
    .map((item) => projectJournalStopNote(item, state.items))
    .sort(compareAgentJournalItems)
}

export function renderJournalState(state: JournalReducerState): AgentJournalSnapshot {
  return {
    sessionId: state.sessionId,
    cursor: journalContextCursor(state),
    items: renderJournalItems(state),
    submissions: [...state.submissions.values()].sort((a, b) => a.submittedAt - b.submittedAt)
  }
}

function resolveItemId(state: JournalReducerState, itemId: string): string {
  return state.aliases.get(itemId) ?? itemId
}
