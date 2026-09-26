// How a `dispatch` row settles its submission. Field by field, so a key the row gains must be
// copied here to reach any reader.

import { readAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

export function applyJournalDispatchRow(
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
  // Read, not copied: a row from disk may carry a fact this build cannot place.
  const rejection =
    row.state === 'rejected' ? readAgentSessionFailureFact(row.rejection) : undefined
  if (rejection) {
    submission.rejection = rejection
  } else {
    delete submission.rejection
  }
  submission.resolvedAt = row.state === 'pending' ? null : row.ts
  if (row.state === 'pending') {
    submission.handedOverAt = row.ts
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
