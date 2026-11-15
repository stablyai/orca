import type { JournalKeyedMap, JournalKeyedSet } from '../journal-keyed-storage'
import type { JournalStateQueries } from '../journal-state-queries'
import type { JournalIndexStorageFactory } from '../journal-index-storage'
import { memoryJournalIndexStorage } from '../journal-memory-index-storage'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import {
  createJournalInputObligations,
  foldJournalInputObligations
} from '../input-order/journal-input-obligations'
import { resolveJournalItemId } from './journal-item-echo'
import { journalInputOrder, initializeJournalInputOrder } from '../input-order/journal-input-order'
import type { JournalInputEntry, JournalInputCard } from '../input-order/journal-input-lineage'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  journalHistoryOrigin,
  type JournalHistoryOrigin
} from '../context-epochs/journal-history-origin'
import { journalBatchMutationProducer, journalRenderItem } from './journal-render-item'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'

import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import { removeJournalItem, statedOrDerivedTurnScope, upsertJournalItem } from './journal-item-fold'
import { journalItemRevisionIsStale } from './journal-item-revision'
import { observeJournalProviderActivity } from './journal-provider-activity'
import { isJournalStopOrResumeRow, type JournalRow } from '../durable-rows/journal-row-schema'
import {
  acceptSubmissionFromProviderItem,
  applyJournalSubmission
} from '../submissions/journal-submission-fold'
import { applyJournalDispatchRow } from './journal-dispatch-reducer'

import { journalItemExecutionFence } from './journal-item-provenance'
import { PULL_REQUEST_EVENT_PRESENTATION } from '../../../../shared/native-chat/native-chat-pull-request-event'
import { retireRewoundJournalSubmission } from '../context-epochs/journal-rewind-submission-retirement'

import {
  createJournalQueuePauseMarks,
  foldJournalQueuePauseMark,
  type JournalQueuePauseMarks
} from '../queued-messages/queued-message-pause-marks'
import {
  createJournalQueueState,
  foldJournalQueueRow,
  type JournalQueueState
} from '../queued-messages/journal-queue-fold'

// Live append and replay share this fold. Revisions change content, preserving creation position
// and unspecified producer linkage; queued/rejected submissions use their handoff/settlement positions.

export const MAX_JOURNAL_APPLIED_SETTLEMENT_IDS = 4_096

export type JournalReducerState = {
  queries: JournalStateQueries
  sessionId: string
  epoch: string
  contextBoundary: number
  lastSequence: number
  lastActivityAt: number
  /** Earliest individually replayable sequence. */
  oldestSequence: number
  highestFence: number
  items: JournalKeyedMap<string, AgentJournalRenderItem>
  /** Creation provenance determines whether an item belongs to current execution. */
  itemFences: JournalKeyedMap<string, number>
  /** Later runs may explicitly assume execution of reusable child items. */
  itemExecutionOwners: JournalKeyedMap<string, number>
  providerActivityAt: JournalKeyedMap<number, number>
  /** Retain removed revisions to prevent stale resurrection. */
  tombstones: JournalKeyedMap<string, number>
  /** Rewound turns remain ended even after their visible records disappear. */
  removedTurnIds: JournalKeyedSet<string>
  inputs: ReturnType<typeof createJournalInputObligations>
  submissions: JournalKeyedMap<string, AgentJournalSubmission>
  receipts: JournalKeyedMap<string, AgentJournalAcceptanceReceipt>
  /** Alias provider echoes to existing optimistic submissions to prevent duplicate bubbles. */
  aliases: JournalKeyedMap<string, string>
  /** Preserve the first declared echo contract through tombstones. */
  itemEchoes: JournalKeyedMap<string, unknown>
  appliedSettlementIds: JournalKeyedSet<string>
  derivedTurnScope: JournalDerivedTurnScope
  /** Acceptance survives visible-message rewind; zero means none in this epoch. */
  latestAcceptedTurnSequence: number
  queuePauseMarks: JournalQueuePauseMarks
  stoppedHistoryCarried: JournalKeyedMap<string, readonly string[]>
  queuedHandOffPlaces: JournalKeyedMap<
    string,
    Pick<AgentJournalRenderItem, 'sequence' | 'observedAt' | 'turnScope'>
  >
  /** Historical display corrections, rebuilt by the hand-off fold on replay. */
  normalizedHandOffs: JournalKeyedSet<string>
  /** The queued messages, folded from their own rows and their hand-offs (`journal-queue-fold.ts`). */
  queue: JournalQueueState
  inputEntries: JournalKeyedMap<string, JournalInputEntry>
  inputCards: JournalKeyedMap<string, JournalInputCard>
  historyOrigin: JournalHistoryOrigin | null
}

export function createJournalReducerState(
  sessionId: string,
  epoch: string,
  storage: JournalIndexStorageFactory = memoryJournalIndexStorage
): JournalReducerState {
  const state: JournalReducerState = {
    queries: storage.stateQueries(),
    sessionId,
    epoch,
    contextBoundary: 1,
    lastSequence: 0,
    lastActivityAt: 0,
    oldestSequence: 1,
    highestFence: 0,
    items: storage.map('items'),
    itemFences: storage.map('itemFences'),
    itemExecutionOwners: storage.map('itemExecutionOwners'),
    providerActivityAt: storage.map('providerActivityAt'),
    tombstones: storage.map('tombstones'),
    removedTurnIds: storage.set('removedTurnIds'),
    inputs: createJournalInputObligations(storage),
    submissions: storage.map('submissions'),
    receipts: storage.map('receipts'),
    aliases: storage.map('aliases'),
    itemEchoes: storage.map('itemEchoes'),
    appliedSettlementIds: storage.set('appliedSettlementIds'),
    derivedTurnScope: new JournalDerivedTurnScope(),
    latestAcceptedTurnSequence: 0,
    queuePauseMarks: createJournalQueuePauseMarks(),
    stoppedHistoryCarried: storage.map('stoppedHistoryCarried'),
    queuedHandOffPlaces: storage.map('queuedHandOffPlaces'),
    normalizedHandOffs: storage.set('normalizedHandOffs'),
    queue: createJournalQueueState(storage),
    inputEntries: storage.map('inputEntries'),
    inputCards: storage.map('inputCards'),
    historyOrigin: null
  }
  initializeJournalInputOrder(state, storage)
  return state
}

export function applyJournalRow(
  state: JournalReducerState,
  row: JournalRow,
  savedAt = row.ts
): void {
  const dispatchApplies =
    row.kind !== 'dispatch' || journalDispatchRowApplies(state.submissions.get(row.clientMessageId))
  journalInputOrder(state).beforeRow(state, row)
  applyJournalRowFacts(state, row, savedAt)
  foldJournalQueueRow(state, row)
  foldJournalInputObligations(state, row, dispatchApplies)
  journalInputOrder(state).afterRow(state, row)
}

/** Marker 5 freezes the common-field interpretation that its outcome tail was written over. */
export function applyMarker5JournalRow(
  state: JournalReducerState,
  row: JournalRow,
  savedAt = row.ts
): void {
  journalInputOrder(state).beforeRow(state, row)
  applyJournalRowFacts(state, row, savedAt, true)
  foldJournalQueueRow(state, row, true)
  journalInputOrder(state).afterRow(state, row)
}

function isPullRequestEventRow(row: JournalRow): boolean {
  return (
    row.kind === 'item' &&
    row.body.kind === 'status' &&
    row.body.presentation === PULL_REQUEST_EVENT_PRESENTATION
  )
}

function applyJournalRowFacts(
  state: JournalReducerState,
  row: JournalRow,
  savedAt: number,
  marker5 = false
): void {
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
  // A CI line is the host's note between turns, not activity in the chat.
  if (!isPullRequestEventRow(row)) {
    state.lastActivityAt = Math.max(state.lastActivityAt, row.ts)
  }
  if (row.kind === 'item') {
    if (journalItemRevisionIsStale(state, row.itemId, row.revision)) {
      return
    }
    if (!state.itemEchoes.has(row.itemId) && Object.hasOwn(row, 'echoOf')) {
      state.itemEchoes.set(row.itemId, row.echoOf)
    }
    const itemId = resolveJournalItemId(state, row.itemId, row.body, marker5)
    if (!state.itemEchoes.has(row.itemId)) {
      acceptSubmissionFromProviderItem(state, row.itemId, itemId, row)
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
      retireRewoundJournalSubmission(state, row.itemId)
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
          acceptSubmissionFromProviderItem(state, mutation.itemId, itemId, row)
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
    const oldest = state.queries.oldestAppliedSettlementId(state)
    if (oldest === undefined) {
      return
    }
    state.appliedSettlementIds.delete(oldest)
  }
}

function resolveItemId(state: JournalReducerState, itemId: string): string {
  return state.aliases.get(itemId) ?? itemId
}
