// Folding submission and dispatch rows: the queue entry, its message row, and the provider item
// an accepted message adopts.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSubmission,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { journalRenderItem } from './journal-render-item'
import { statedOrDerivedTurnScope, upsertJournalItem } from './journal-item-fold'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

export function applyJournalSubmission(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'submission' }>
): void {
  state.submissions.set(row.clientMessageId, {
    clientMessageId: row.clientMessageId,
    fence: row.fence,
    payloadFingerprint: row.payloadFingerprint,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: row.ts,
    resolvedAt: null,
    ...(row.handoverRecorded ? { handoverRecorded: true, acceptedSequence: row.seq } : {})
  })
  const itemId = agentJournalSubmissionKey(row.clientMessageId)
  // A message handed over later belongs to no turn until its handover names one.
  const turnScope = row.handoverRecorded
    ? AGENT_JOURNAL_THREAD_SCOPE
    : statedOrDerivedTurnScope(state, row)
  upsertJournalItem(state, itemId, 0, journalRenderItem(itemId, 0, row.body, row, turnScope))
}

export function applyJournalDispatch(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'dispatch' }>
): void {
  const submission = state.submissions.get(row.clientMessageId)
  if (!submission) {
    return
  }
  // `rejected` is terminal; a late `unknown` must not reopen a settled answer.
  if (submission.dispatchState === 'rejected' || submission.dispatchState === 'accepted') {
    return
  }
  submission.fence = row.fence
  submission.dispatchState = row.state
  submission.providerItemId = row.providerItemId
  submission.reason = row.reason
  submission.resolvedAt = row.state === 'pending' ? null : row.ts
  if (row.state === 'pending') {
    submission.handedOverAt = row.ts
    scopeHandedOverMessage(state, submission, row.turnScope)
  }
  if (row.recovered) {
    submission.recovered = row.recovered
  } else {
    delete submission.recovered
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

/** A queued message joins the turn it was handed into — a steer — or none. Rows from hosts that
 *  predate the stated scope are placed at the handover, as their creation would have been. */
function scopeHandedOverMessage(
  state: JournalReducerState,
  submission: AgentJournalSubmission,
  stated: AgentJournalTurnScope | undefined
): void {
  const itemId = agentJournalSubmissionKey(submission.clientMessageId)
  const item = state.items.get(itemId)
  if (!submission.handoverRecorded || !item) {
    return
  }
  state.items.set(itemId, {
    ...item,
    turnScope: stated ?? state.derivedTurnScope.scopeFor(item.body)
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
  if (
    !submission ||
    submission.dispatchState === 'accepted' ||
    submission.dispatchState === 'rejected'
  ) {
    return
  }
  submission.fence = row.fence
  submission.dispatchState = 'accepted'
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
