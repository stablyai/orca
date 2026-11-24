import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import { compareQueuedRows } from './input-order/journal-queued-row-index'
import { deriveQueuePauses, type DerivedQueuePause } from './queued-messages/queued-message-pause'
import { journalUserStopInForce } from './queued-messages/queued-message-pause-marks'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import {
  readJournalDomainQueueRow,
  SELECT_JOURNAL_DOMAIN_QUEUE_ROW
} from './journal-domain-queue-rows'
import { readJournalDomainQueuePauseContext } from './journal-domain-queue-pauses'

type Target = { sessionId: string; epoch: string }

function liveCards(db: Database.Database, target: Target): QueuedMessageRow[] {
  return db
    .prepare(`${SELECT_JOURNAL_DOMAIN_QUEUE_ROW} WHERE session_id=? AND epoch=?
      AND state IN ('waiting','returned') ORDER BY position, message_id`)
    .all(target.sessionId, target.epoch)
    .map((row) => readJournalDomainQueueRow(target.sessionId, row).card)
}

/** Dispatched cards whose current attempt is still owed delivery, from the finite recovery index. */
function owedDispatchedCards(
  db: Database.Database,
  target: Target,
  owed: (submission: AgentJournalSubmission) => boolean
): QueuedMessageRow[] {
  return db
    .prepare(`SELECT card.message_id, card.revision, card.state, card.position, card.payload_json,
      attempt.message_id AS attempt_id, attempt.payload_json AS attempt_json
    FROM journal_submission_attempts AS attempt INDEXED BY journal_submission_recovery
    JOIN journal_queue_cards AS card ON card.session_id=attempt.session_id
      AND card.epoch=attempt.epoch AND card.message_id=attempt.admission_family_id
    WHERE attempt.session_id=? AND attempt.epoch=? AND attempt.current=1
      AND (attempt.dispatch_state='pending' OR (attempt.dispatch_state='unknown' AND attempt.recovered=0))
      AND card.state='dispatched'`)
    .all(target.sessionId, target.epoch)
    .flatMap((row) => {
      const { card } = readJournalDomainQueueRow(target.sessionId, row)
      const submission: AgentJournalSubmission = JSON.parse(String(row.attempt_json))
      return card.consumedAs === String(row.attempt_id) && owed(submission) ? [card] : []
    })
}

/** Membership outlives automatic eligibility until the card's handoff completes. */
export function readJournalDomainQueueList(
  db: Database.Database,
  target: Target
): QueuedMessageRow[] {
  return [
    ...liveCards(db, target),
    ...owedDispatchedCards(db, target, isQueuedAgentJournalSubmission)
  ].sort(compareQueuedRows)
}

export function readJournalDomainQueueHead(
  db: Database.Database,
  target: Target
): { lastSequence: number; queueRevision: number; clearedThrough: number } {
  const head = db
    .prepare(`SELECT last_sequence, queue_revision, queue_clear_sequence, queue_clear_operation_id
    FROM journal_chat_state WHERE session_id=? AND epoch=?`)
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal queue read targets a retired chat epoch')
  }
  return {
    lastSequence: Number(head.last_sequence),
    queueRevision: Number(head.queue_revision),
    clearedThrough:
      head.queue_clear_operation_id === null ? 0 : Number(head.queue_clear_sequence ?? 0)
  }
}

/** A recovered doubt outlived its writer: nothing brings that card back to waiting. */
export function journalDomainQueueAwaitsReopen(db: Database.Database, target: Target): boolean {
  const waiting = db
    .prepare(`SELECT 1 FROM journal_queue_cards INDEXED BY journal_queue_order
      WHERE session_id=? AND epoch=? AND state IN ('waiting','returned') AND state='waiting' LIMIT 1`)
    .get(target.sessionId, target.epoch)
  return waiting !== undefined || owedDispatchedCards(db, target, () => true).length > 0
}

/** Clear and reopen membership are listed only for cards a pause can hold. */
export function readJournalDomainQueuePauses(
  db: Database.Database,
  target: Target,
  reopenFloor: AgentJournalCursor | null
): DerivedQueuePause[] {
  const cards = liveCards(db, target).filter(
    (card) => card.state === 'waiting' && card.holdReason === null
  )
  const context = readJournalDomainQueuePauseContext(
    db,
    target,
    reopenFloor,
    cards.map((card) => card.messageId)
  )
  const { cleared } = context.marks
  return deriveQueuePauses({
    ...context,
    marks: {
      ...context.marks,
      ...(cleared ? { cleared: { ...cleared, messageIds: [...context.clearMembers] } } : {})
    },
    cards
  })
}

export function readJournalDomainUserStopInForce(
  db: Database.Database,
  target: Target
): JournalLatestStop | null {
  const context = readJournalDomainQueuePauseContext(db, target, null, [])
  return journalUserStopInForce(
    context.marks,
    context.latestPersonAcceptedTurnSequence ?? context.latestAcceptedTurnSequence
  )
}
