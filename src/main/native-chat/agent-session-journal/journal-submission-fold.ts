import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import { journalRenderItem } from './journal-render-item'
import { statedOrDerivedTurnScope, upsertJournalItem } from './journal-item-fold'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import { DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED } from './journal-dispatch-doubt-reasons'
import { dispatchWasWithdrawn } from '../../../shared/structured-agent-session-dispatch-rejection'

export function applyJournalSubmission(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'submission' }>
): void {
  const options = readAgentSessionExecutionOptions(row.options)
  state.submissions.set(row.clientMessageId, {
    clientMessageId: row.clientMessageId,
    fence: row.fence,
    payloadFingerprint: row.payloadFingerprint,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: row.ts,
    resolvedAt: null,
    submittedSequence: row.seq,
    ...(row.handoverRecorded ? { handoverRecorded: true, acceptedSequence: row.seq } : {}),
    ...(typeof row.queuedMessageId === 'string' && row.queuedMessageId.length > 0
      ? { queuedMessageId: row.queuedMessageId }
      : {}),
    ...(row.origin === 'client' || row.origin === 'host' ? { origin: row.origin } : {}),
    // Preserve source presence: unknown/unreadable kinds must not become legacy user sends.
    ...(row.source !== undefined ? { source: { kind: storedSourceKind(row.source) } } : {}),
    ...(options ? { options } : {})
  })
  const itemId = agentJournalSubmissionKey(row.clientMessageId)
  // Delayed handovers belong to no turn until dispatch names one.
  const turnScope = row.handoverRecorded
    ? AGENT_JOURNAL_THREAD_SCOPE
    : statedOrDerivedTurnScope(state, row)
  upsertJournalItem(
    state,
    itemId,
    0,
    journalRenderItem(itemId, 0, row.body, row, turnScope),
    // User messages retain admission provenance, not provider execution ownership.
    { fence: row.fence }
  )
}

/** Place at handover, after intervening work; scope legacy rows from the handover position. */
export function placeHandedOverMessage(
  state: JournalReducerState,
  submission: AgentJournalSubmission,
  row: Extract<JournalRow, { kind: 'dispatch' }>
): void {
  const itemId = agentJournalSubmissionKey(submission.clientMessageId)
  const item = state.items.get(itemId)
  if (!submission.handoverRecorded || !item) {
    return
  }
  const { sequenceIndex: _acceptedAt, ...accepted } = item
  const place = {
    sequence: row.seq,
    observedAt: row.ts,
    turnScope: row.turnScope ?? state.derivedTurnScope.scopeFor(item.body)
  }
  state.items.set(itemId, { ...accepted, ...place })
  if (submission.queuedMessageId !== undefined) {
    state.queuedHandOffPlaces.set(submission.clientMessageId, place)
  }
}

/** Uncertain handoffs remain spent at their handover position; derive display without rewriting rejection. */
export function foldQueuedHandOffInDoubt(
  state: JournalReducerState,
  submission: AgentJournalSubmission
): void {
  const itemId = agentJournalSubmissionKey(submission.clientMessageId)
  const item = state.items.get(itemId)
  const place = state.queuedHandOffPlaces.get(submission.clientMessageId)
  if (item && place) {
    const { sequenceIndex: _rejectedAt, ...rest } = item
    state.items.set(itemId, { ...rest, ...place })
  }
  if (dispatchWasWithdrawn(submission) && !submission.answeredInTurn) {
    delete submission.queuedMessageId
    return
  }
  submission.dispatchState = 'unknown'
  submission.reason = DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED
  submission.recovered = true
  delete submission.rejection
}

/** Place proven rejections at settlement in thread scope; uncertain deliveries retain their position. */
export function placeRejectedMessage(
  state: JournalReducerState,
  submission: AgentJournalSubmission,
  row: Extract<JournalRow, { kind: 'dispatch' }>
): void {
  const itemId = agentJournalSubmissionKey(submission.clientMessageId)
  const item = state.items.get(itemId)
  if (row.state !== 'rejected' || !item) {
    return
  }
  const { sequenceIndex: _placed, ...rest } = item
  state.items.set(itemId, {
    ...rest,
    sequence: row.seq,
    observedAt: row.ts,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
}

export function acceptSubmissionFromProviderItem(
  state: JournalReducerState,
  providerItemId: string,
  resolvedItemId: string,
  row: Pick<JournalRow, 'epoch' | 'seq' | 'fence' | 'ts'>
): void {
  if (providerItemId === resolvedItemId) {
    return
  }
  const submission = [...state.submissions.values()].find(
    (candidate) => agentJournalSubmissionKey(candidate.clientMessageId) === resolvedItemId
  )
  if (!submission || !journalDispatchRowApplies(submission)) {
    return
  }
  submission.fence = row.fence
  submission.dispatchState = 'accepted'
  noteTurnAccepted(state, submission)
  submission.providerItemId = providerItemId
  submission.reason = null
  submission.resolvedAt = row.ts
  delete submission.recovered
  state.receipts.set(submission.clientMessageId, {
    clientMessageId: submission.clientMessageId,
    providerItemId,
    cursor: { epoch: row.epoch, sequence: row.seq },
    acceptedAt: row.ts
  })
}

/** Any provider-accepted turn may lift queue pauses. */
export function noteTurnAccepted(
  state: JournalReducerState,
  submission: Pick<AgentJournalSubmission, 'acceptedSequence'>
): void {
  if (submission.acceptedSequence !== undefined) {
    state.latestAcceptedTurnSequence = Math.max(
      state.latestAcceptedTurnSequence,
      submission.acceptedSequence
    )
  }
}

/** Unreadable source kinds stay distinct from personal sends. */
function storedSourceKind(stored: unknown): string {
  return typeof stored === 'object' &&
    stored !== null &&
    'kind' in stored &&
    typeof stored.kind === 'string'
    ? stored.kind
    : ''
}
