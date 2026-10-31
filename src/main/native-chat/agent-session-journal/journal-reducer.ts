import { journalItemDeclaresEcho } from './journal-item-echo'
import {
  journalInputOrder,
  initializeJournalInputOrder,
  type JournalInputOrder
} from './journal-input-order'
import type { JournalInputEntry, JournalInputCard } from './journal-input-lineage'
// Live append and replay share this fold. Revisions change content, preserving creation position
// and unspecified producer linkage; queued/rejected submissions use their handoff/settlement positions.

import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { journalHistoryOrigin, type JournalHistoryOrigin } from './journal-history-origin'
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
import { observeJournalProviderActivity } from './journal-provider-activity'
import { isJournalStopOrResumeRow, type JournalRow } from './journal-row-schema'
import { acceptSubmissionFromProviderItem, applyJournalSubmission } from './journal-submission-fold'
import { applyJournalDispatchRow } from './journal-dispatch-reducer'
import { isWriteFailureSubmission } from '../../../shared/structured-agent-session-dispatch-rejection'
import { projectJournalStopNote } from './journal-stop-note-projection'
import { journalItemExecutionFence } from './journal-item-provenance'
import { retireRewoundJournalSubmission } from './journal-rewind-submission-retirement'
import { latestAgentSessionContextClearSequence } from '../../../shared/agent-session-context-clear'
import {
  createJournalQueuePauseMarks,
  foldJournalQueuePauseMark,
  type JournalQueuePauseMarks
} from './queued-message-pause'
import {
  createJournalQueueState,
  foldJournalQueueRow,
  type JournalQueueState
} from './journal-queue-fold'

export const MAX_JOURNAL_APPLIED_SETTLEMENT_IDS = 4_096

export type JournalReducerState = {
  sessionId: string
  epoch: string
  lastSequence: number
  lastActivityAt: number
  /** Earliest individually replayable sequence. */
  oldestSequence: number
  highestFence: number
  items: Map<string, AgentJournalRenderItem>
  /** Creation provenance determines whether an item belongs to current execution. */
  itemFences: Map<string, number>
  /** Later runs may explicitly assume execution of reusable child items. */
  itemExecutionOwners: Map<string, number>
  providerActivityAt: Map<number, number>
  /** Retain removed revisions to prevent stale resurrection. */
  tombstones: Map<string, number>
  /** Rewound turns remain ended even after their visible records disappear. */
  removedTurnIds: Set<string>
  submissions: Map<string, AgentJournalSubmission>
  receipts: Map<string, AgentJournalAcceptanceReceipt>
  /** Alias provider echoes to existing optimistic submissions to prevent duplicate bubbles. */
  aliases: Map<string, string>
  /** Preserve the first declared echo contract through tombstones. */
  itemEchoes: Map<string, unknown>
  appliedSettlementIds: Set<string>
  derivedTurnScope: JournalDerivedTurnScope
  /** Acceptance survives visible-message rewind; zero means none in this epoch. */
  latestAcceptedTurnSequence: number
  queuePauseMarks: JournalQueuePauseMarks
  stoppedHistoryCarried: Map<string, readonly string[]>
  queuedHandOffPlaces: Map<
    string,
    Pick<AgentJournalRenderItem, 'sequence' | 'observedAt' | 'turnScope'>
  >
  /** Historical display corrections, rebuilt by the hand-off fold on replay. */
  normalizedHandOffs: Set<string>
  /** The queued messages, folded from their own rows and their hand-offs (`journal-queue-fold.ts`). */
  queue: JournalQueueState
  inputEntries: Map<string, JournalInputEntry>
  inputCards: Map<string, JournalInputCard>
  historyOrigin: JournalHistoryOrigin | null
}

export function createJournalReducerState(
  sessionId: string,
  epoch: string,
  originalAcceptance?: ConstructorParameters<typeof JournalInputOrder>[1]
): JournalReducerState {
  const state: JournalReducerState = {
    sessionId,
    epoch,
    lastSequence: 0,
    lastActivityAt: 0,
    oldestSequence: 1,
    highestFence: 0,
    items: new Map(),
    itemFences: new Map(),
    itemExecutionOwners: new Map(),
    providerActivityAt: new Map(),
    tombstones: new Map(),
    removedTurnIds: new Set(),
    submissions: new Map(),
    receipts: new Map(),
    aliases: new Map(),
    itemEchoes: new Map(),
    appliedSettlementIds: new Set(),
    derivedTurnScope: new JournalDerivedTurnScope(),
    latestAcceptedTurnSequence: 0,
    queuePauseMarks: createJournalQueuePauseMarks(),
    stoppedHistoryCarried: new Map(),
    queuedHandOffPlaces: new Map(),
    normalizedHandOffs: new Set(),
    queue: createJournalQueueState(),
    inputEntries: new Map(),
    inputCards: new Map(),
    historyOrigin: null
  }
  initializeJournalInputOrder(state, originalAcceptance)
  return state
}

export function applyJournalRow(
  state: JournalReducerState,
  row: JournalRow,
  savedAt = row.ts
): void {
  journalInputOrder(state).beforeRow(state, row)
  applyJournalRowFacts(state, row, savedAt)
  foldJournalQueueRow(state, row)
  journalInputOrder(state).afterRow(state, row)
}

function applyJournalRowFacts(state: JournalReducerState, row: JournalRow, savedAt: number): void {
  state.lastSequence = Math.max(state.lastSequence, row.seq)
  state.highestFence = Math.max(state.highestFence, row.fence)
  if (row.kind === 'epoch') {
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
    const itemId = resolveJournalItemId(state, row.itemId, row.body)
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
        const itemId = resolveJournalItemId(state, mutation.itemId, body)
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

/** Find an echo's eligible submission without claiming it. */
export function journalEchoClaimant(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string | null {
  if (
    !body ||
    journalItemDeclaresEcho(state.itemEchoes, itemId) ||
    !isProviderUserMessageEcho(itemId, body)
  ) {
    return null
  }
  const fingerprint = agentSessionSendBodyFingerprint(state.sessionId, body)
  const contextSequence = latestAgentSessionContextClearSequence(state.items.values())
  // Match equal payloads in send order; proven-undelivered legacy rows cannot claim later resend echoes.
  const submission = [...state.submissions.values()]
    .sort((left, right) => left.submittedAt - right.submittedAt)
    .find(
      (candidate) =>
        (contextSequence === 0 || (candidate.acceptedSequence ?? 0) > contextSequence) &&
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

export function renderJournalState(state: JournalReducerState): AgentJournalSnapshot {
  // Map insertion order changes on recreation; journal position alone orders the timeline.
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
