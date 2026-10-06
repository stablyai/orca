// How a `dispatch` row settles its submission. Field by field, so a key the row gains must be
// copied here to reach any reader.

import {
  readAgentSessionFailureFact,
  type UnreadAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalAnsweredTurn } from '../../../shared/agent-session-journal-types'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import type { JournalReducerState } from './journal-reducer'
import {
  notePersonTurnAccepted,
  placeHandedOverMessage,
  placeRejectedMessage
} from './journal-submission-fold'
import type { JournalRow } from './journal-row-schema'

export function applyJournalDispatchRow(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'dispatch' }>
): void {
  const submission = state.submissions.get(row.clientMessageId)
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
  submission.resolvedAt = row.state === 'pending' ? null : row.ts
  if (row.state === 'pending') {
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
