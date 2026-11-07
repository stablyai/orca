import { journalInputOrder } from '../input-order/journal-input-order'
import { dispatchWasWithdrawn } from '../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  journalDispatchRowApplies,
  queuedHandOffInDoubt
} from '../projection/journal-dispatch-settlement'
import type { JournalQueuedChange } from './journal-queue-events'
import { queuedCardFromChange } from './journal-queue-fold'
import { queuedChangeOf } from './journal-queue-retention'
import type { JournalReducerState } from '../projection/journal-reducer'
import {
  QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED,
  type QueuedMessageRow
} from './queued-message-table'

/** Preserve handoff links; copy refusals only when their original rows are no longer in this epoch. */
export function legacyQueuedChange(
  state: JournalReducerState,
  row: QueuedMessageRow
): JournalQueuedChange | null {
  const unconfirmed = row.state === 'waiting' ? unconfirmedHandOff(state, row) : null
  const attempt = row.state === 'waiting' ? (unconfirmed?.attempt ?? null) : row.consumedAs
  if (row.state === 'withdrawn' || (row.state === 'dispatched' && attempt === null)) {
    return null
  }
  const holdReason = unconfirmed?.holdReason ?? (row.state === 'waiting' ? row.holdReason : null)
  const change: JournalQueuedChange = {
    ...queuedChangeOf(row),
    ...(holdReason !== null ? { holdReason } : {}),
    ...(attempt !== null ? { attempt } : {}),
    ...(unconfirmed?.recovers ? { recovers: unconfirmed.recovers } : {}),
    ...(row.state === 'returned' && (attempt === null || !state.submissions.has(attempt))
      ? {
          returned: {
            reason: row.returnedReason,
            ...(row.returnedRejection ? { rejection: row.returnedRejection } : {})
          }
        }
      : {})
  }
  const card = queuedCardFromChange(state, row.messageId, change)
  return unanswered(card, state.submissions) ? change : null
}

/** Legacy refusals may have cleared handoff links without proving non-delivery.
 * Spend unchanged cards on uncertain attempts; edited/resubmitted cards require explicit Send. */
function unconfirmedHandOff(
  state: JournalReducerState,
  row: QueuedMessageRow
):
  | { attempt: string; holdReason?: undefined; recovers?: undefined }
  | { attempt?: undefined; holdReason: string; recovers?: string }
  | null {
  const attempts = [...journalInputOrder(state).linkedTo(row.messageId)].sort(
    (a, b) => (a.submittedSequence ?? 0) - (b.submittedSequence ?? 0)
  )
  if (!attempts.some(handOffInDoubt)) {
    return null
  }
  const latest = attempts.at(-1)!
  return handOffInDoubt(latest) && latest.payloadFingerprint === row.fingerprint
    ? { attempt: latest.clientMessageId }
    : {
        holdReason: QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED,
        ...(handOffInDoubt(latest) && (!dispatchWasWithdrawn(latest) || latest.answeredInTurn)
          ? { recovers: latest.clientMessageId }
          : {})
      }
}

function handOffInDoubt(submission: AgentJournalSubmission): boolean {
  return queuedHandOffInDoubt(submission)
}

export function unanswered(
  card: QueuedMessageRow,
  submissions: ReadonlyMap<string, AgentJournalSubmission>
): boolean {
  if (card.state !== 'dispatched') {
    return card.state !== 'withdrawn'
  }
  const handOff = card.consumedAs === null ? undefined : submissions.get(card.consumedAs)
  return handOff === undefined || journalDispatchRowApplies(handOff) || handOffInDoubt(handOff)
}
