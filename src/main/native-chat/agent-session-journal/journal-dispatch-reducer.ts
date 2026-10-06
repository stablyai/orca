// How a `dispatch` row settles its submission. Field by field, so a key the row gains must be
// copied here to reach any reader.

import {
  readAgentSessionFailureFact,
  type UnreadAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_REJECTION_CAUSES,
  type AgentJournalAnsweredTurn,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import {
  isFailedStartRejection,
  isRequeueableAgentJournalSubmission
} from '../../../shared/structured-agent-session-dispatch-rejection'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import type { JournalReducerState } from './journal-reducer'
import {
  notePersonTurnAccepted,
  placeHandedOverMessage,
  placeRejectedMessage
} from './journal-submission-fold'
import type { JournalRow, JournalStartRetryRecord } from './journal-row-schema'

/** The one way back from `rejected`: the person's Retry of a message no agent ever took. It is
 *  queued again under its own id, accepted anew at the Retry's row: never handed over, no failure,
 *  no booked try. Its acceptance moves because every "accepted before" rule — what an earlier
 *  process left queued, what a close or Stop took, what a stop it waits on precedes — must read the
 *  Retry as the person's latest ask. It is sent now, ahead of the queue, so it stays drawn where its
 *  failure was written, ahead of what was queued since. Any other row for a settled message still
 *  changes nothing. */
function requeueRejectedSubmission(
  submission: AgentJournalSubmission | undefined,
  row: Extract<JournalRow, { kind: 'dispatch' }>
): void {
  if (row.state !== 'pending' || !submission || !isRequeueableAgentJournalSubmission(submission)) {
    return
  }
  submission.fence = row.fence
  submission.acceptedSequence = row.seq
  submission.retriedInPlace = true
  submission.dispatchState = 'pending'
  submission.providerItemId = null
  submission.reason = null
  submission.resolvedAt = null
  delete submission.rejection
  delete submission.rejectionCause
  delete submission.answeredInTurn
  delete submission.startRetry
  delete submission.recovered
}

export function applyJournalDispatchRow(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'dispatch' }>
): void {
  const submission = state.submissions.get(row.clientMessageId)
  if (row.requeued === true) {
    requeueRejectedSubmission(submission, row)
    return
  }
  // Shared with the queued-draft returned hook: a row ignored here must not alter a draft.
  if (!submission || !journalDispatchRowApplies(submission)) {
    return
  }
  submission.fence = row.fence
  submission.dispatchState = row.state
  submission.providerItemId = row.providerItemId
  submission.reason = row.reason
  const rejection = row.state === 'rejected' ? readStoredRejectionFact(row.rejection) : undefined
  if (rejection) {
    submission.rejection = rejection
  } else {
    delete submission.rejection
  }
  if (row.state === 'rejected' && row.answeredInTurn !== undefined) {
    submission.answeredInTurn = readAnsweredTurn(row.answeredInTurn)
  } else {
    delete submission.answeredInTurn
  }
  const rejectionCause = AGENT_JOURNAL_REJECTION_CAUSES.find(
    (cause) => row.state === 'rejected' && cause === row.rejectionCause
  )
  if (rejectionCause) {
    submission.rejectionCause = rejectionCause
  } else {
    delete submission.rejectionCause
  }
  if (rejection && isFailedStartRejection({ reason: row.reason, rejection })) {
    // Its child took nothing it was handed: never handed over.
    delete submission.handedOverAt
  }
  submission.resolvedAt = row.state === 'pending' ? null : row.ts
  const startRetry = row.state === 'pending' ? readStoredStartRetry(row.startRetry) : undefined
  if (startRetry) {
    // Still queued, its start refused before it ran: each refusal is one more attempt. Only a queued
    // message is written this way; nothing handed over waits for another start.
    submission.startRetry = {
      attempts: (submission.startRetry?.attempts ?? 0) + 1,
      ...startRetry,
      failedAt: row.ts
    }
  } else {
    delete submission.startRetry
  }
  if (row.state === 'pending' && !startRetry) {
    submission.handedOverAt = row.ts
    placeHandedOverMessage(state, submission, row)
  } else if (row.state === 'rejected') {
    placeRejectedMessage(state, submission, row)
  }
  if (row.recovered) {
    submission.recovered = row.recovered
  } else {
    delete submission.recovered
  }
  if (row.state === 'accepted') {
    notePersonTurnAccepted(state, submission)
  }
  if (row.state !== 'accepted' || !row.providerItemId) {
    return
  }
  state.aliases.set(row.providerItemId, agentJournalSubmissionKey(row.clientMessageId))
  state.receipts.set(row.clientMessageId, {
    clientMessageId: row.clientMessageId,
    providerItemId: row.providerItemId,
    cursor: { epoch: row.epoch, sequence: row.seq },
    acceptedAt: row.ts
  })
}

/** A stored answered turn. One malformed, or naming a way of joining this build does not know, is
 *  read as no turn: it was written knowing the field, so it is not an older row. */
function readAnsweredTurn(value: unknown): AgentJournalAnsweredTurn | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const turnItemId = 'turnItemId' in value ? value.turnItemId : undefined
  const via = 'via' in value ? value.via : undefined
  return typeof turnItemId === 'string' && turnItemId && (via === 'start' || via === 'steer')
    ? { turnItemId, via }
    : null
}

/** A stored rejection fact, read where it can be placed; a kind it cannot place is kept as
 *  written, so the classifier still knows a fact was there without this build claiming what it
 *  says. Shared with the queued-draft table, whose returned card mirrors its submission. */
export function readStoredRejectionFact(value: unknown): UnreadAgentSessionFailureFact | undefined {
  return readAgentSessionFailureFact(value) ?? unreadFailureFact(value)
}

function unreadFailureFact(value: unknown): UnreadAgentSessionFailureFact | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    value.kind
    ? { kind: value.kind }
    : undefined
}

/** A failed start as its row recorded it; undefined when anything it needs is malformed. */
function readStoredStartRetry(value: unknown): JournalStartRetryRecord | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const reason = 'reason' in value ? value.reason : undefined
  const rejection = readAgentSessionFailureFact('rejection' in value ? value.rejection : undefined)
  const nextAttemptAt = 'nextAttemptAt' in value ? value.nextAttemptAt : undefined
  if (
    typeof reason !== 'string' ||
    !rejection ||
    typeof nextAttemptAt !== 'number' ||
    !Number.isFinite(nextAttemptAt)
  ) {
    return undefined
  }
  return {
    reason,
    rejection,
    nextAttemptAt
  }
}
