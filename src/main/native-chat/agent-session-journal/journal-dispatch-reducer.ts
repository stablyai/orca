import {
  readAgentSessionFailureFact,
  type UnreadAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalAnsweredTurn } from '../../../shared/agent-session-journal-types'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import { boundInlineText, JOURNAL_DISPATCH_REASON_LIMITS } from './journal-payload-bounds'
import type { JournalReducerState } from './journal-reducer'
import {
  noteTurnAccepted,
  placeHandedOverMessage,
  placeRejectedMessage
} from './journal-submission-fold'
import type { JournalRow } from './journal-row-schema'

export function applyJournalDispatchRow(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'dispatch' }>
): void {
  const submission = state.submissions.get(row.clientMessageId)
  // Ignored dispatch rows must not change queue cards either.
  if (!submission || !journalDispatchRowApplies(submission)) {
    return
  }
  submission.fence = row.fence
  submission.dispatchState = row.state
  submission.providerItemId = row.providerItemId
  // Bound legacy reasons written before the write-side limit (#20654).
  submission.reason =
    row.reason === null ? null : boundInlineText(row.reason, JOURNAL_DISPATCH_REASON_LIMITS).text
  const rejection = row.state === 'rejected' ? readStoredRejectionFact(row.rejection) : undefined
  if (rejection) {
    submission.rejection = rejection
  } else {
    delete submission.rejection
  }
  if (
    row.state === 'rejected' &&
    typeof row.keptAsQueuedMessageId === 'string' &&
    row.keptAsQueuedMessageId.length > 0
  ) {
    submission.keptAsQueuedMessageId = row.keptAsQueuedMessageId
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
    foldStoppedHistoryCarried(state, row)
  } else if (row.state === 'rejected') {
    placeRejectedMessage(state, submission, row)
  }
  if (row.recovered) {
    submission.recovered = row.recovered
  } else {
    delete submission.recovered
  }
  if (row.state === 'accepted') {
    noteTurnAccepted(state, submission)
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

/** A rebind replaces coverage, including an empty set, before the new child receives input. */
function foldStoppedHistoryCarried(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'dispatch' }>
): void {
  const carried = Array.isArray(row.carries)
    ? row.carries.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  if (carried.length > 0) {
    state.stoppedHistoryCarried.set(row.clientMessageId, carried)
  } else {
    state.stoppedHistoryCarried.delete(row.clientMessageId)
  }
}

/** Malformed/unknown joins mean no answered turn, distinct from legacy rows lacking the field. */
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

/** Preserve unknown rejection facts so newer typed evidence cannot be replaced by a guessed reason. */
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
