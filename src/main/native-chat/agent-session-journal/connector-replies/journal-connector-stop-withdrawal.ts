// A send a person's Stop or close took back reads as stopped in its conversation, never as failed.
// Decided in the transaction that saves the rejection: the chat keeps only its latest Stop, so a
// later Stop would hide the one that took the send back.
import type Database from '../../../sqlite/sync-database'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalLatestStop } from '../context-epochs/journal-stop-turn-end'
import { personStopTookBack, stopMayHaveRejected } from './journal-connector-stop-rule'
import { withdrawJournalConnectorReplies } from './journal-connector-replies'
import { readJournalDomainSubmissionAttempt } from '../journal-domain-submission-records'
import { journalDomainQueueRow } from '../journal-domain-queue-rows'

type Target = { sessionId: string; epoch: string }

// Whether any of these messages admitted or claimed an unanswered connector row. Index-backed,
// so its cost never grows with the chat's backlog.
function ownsOpenReplies(db: Database.Database, target: Target, ids: readonly string[]): boolean {
  const owns = db.prepare(`SELECT 1 FROM journal_connector_replies
    WHERE session_id=? AND epoch=? AND message_id=? AND outcome IS NULL LIMIT 1`)
  const claims = db.prepare(`SELECT 1 FROM journal_connector_replies
    WHERE claim_message_id=? AND session_id=? AND epoch=? AND outcome IS NULL LIMIT 1`)
  return ids.some(
    (id) =>
      owns.get(target.sessionId, target.epoch, id) !== undefined ||
      claims.get(id, target.sessionId, target.epoch) !== undefined
  )
}

// A card that is waiting or returned can still run, and its answer goes to the same rows.
function cardStillRuns(db: Database.Database, target: Target, send: AgentJournalSubmission) {
  return [send.queuedMessageId, send.keptAsQueuedMessageId, send.clientMessageId].some((id) => {
    const state = id === undefined ? undefined : journalDomainQueueRow(db, target, id)?.card.state
    return state === 'waiting' || state === 'returned'
  })
}

function savedStop(db: Database.Database, target: Target): JournalLatestStop | null {
  const row = db
    .prepare(`SELECT queue_latest_stop_json FROM journal_chat_state
    WHERE session_id=? AND epoch=?`)
    .get(target.sessionId, target.epoch)
  return row?.queue_latest_stop_json == null ? null : JSON.parse(String(row.queue_latest_stop_json))
}

// A queued send's row may name its card rather than the send.
const rowIdsOf = (send: AgentJournalSubmission) => [
  send.clientMessageId,
  ...(send.queuedMessageId ? [send.queuedMessageId] : [])
]

/** Withdraws the rows of each send the saved person's Stop took back, once the rejection and any
 *  card it returned are saved. */
function withdrawTakenBack(
  db: Database.Database,
  target: Target,
  send: AgentJournalSubmission,
  savedAt: number
): void {
  const ids = rowIdsOf(send)
  if (
    ownsOpenReplies(db, target, ids) &&
    !cardStillRuns(db, target, send) &&
    personStopTookBack(send, savedStop(db, target)?.event ?? null)
  ) {
    withdrawJournalConnectorReplies(db, target, ids, savedAt)
  }
}

/** In the transaction that just saved a send's rejection. */
export function withdrawStopRejectedConnectorReplies(
  db: Database.Database,
  target: Target,
  send: AgentJournalSubmission,
  savedAt: number
): void {
  if (send.dispatchState === 'rejected' && stopMayHaveRejected(send)) {
    withdrawTakenBack(db, target, send, savedAt)
  }
}

/** In a Stop's acceptance, after the Stop is saved: the queued sends it withdrew were saved before it. */
export function withdrawStopTakenBackReplies(
  db: Database.Database,
  target: Target,
  messageIds: readonly string[],
  savedAt: number
): void {
  for (const messageId of messageIds) {
    const send = readJournalDomainSubmissionAttempt(db, target, messageId, false)?.submission
    if (send && stopMayHaveRejected(send)) {
      withdrawTakenBack(db, target, send, savedAt)
    }
  }
}
