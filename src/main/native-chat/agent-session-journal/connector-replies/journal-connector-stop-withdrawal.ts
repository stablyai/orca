// A send a person's Stop or close took back reads as stopped in its conversation, never as failed.
// Decided in the transaction that saves the rejection: the chat keeps only its latest Stop, so a
// later Stop would hide the one that took the send back.
import type Database from '../../../sqlite/sync-database'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalLatestStop } from '../context-epochs/journal-stop-turn-end'
import { personStopTookBack, stopMayHaveRejected } from './journal-connector-stop-rule'
import { withdrawJournalConnectorReplies } from './journal-connector-replies'
import { readJournalDomainSubmissionAttempt } from '../journal-domain-submission-records'

type Target = { sessionId: string; epoch: string }

/** In the transaction that just saved a send's rejection: its conversation rows are withdrawn when
 *  the chat's saved Stop is the person's Stop that took it back. */
export function withdrawStopRejectedConnectorReplies(
  db: Database.Database,
  target: Target,
  send: AgentJournalSubmission,
  savedAt: number
): void {
  if (send.dispatchState !== 'rejected' || !stopMayHaveRejected(send)) {
    return
  }
  const row = db
    .prepare(`SELECT queue_latest_stop_json FROM journal_chat_state
    WHERE session_id=? AND epoch=?`)
    .get(target.sessionId, target.epoch)
  const latest: JournalLatestStop | null =
    row?.queue_latest_stop_json == null ? null : JSON.parse(String(row.queue_latest_stop_json))
  if (personStopTookBack(send, latest?.event ?? null)) {
    // A queued send's row may name its card rather than the send.
    const ids = [send.clientMessageId, ...(send.queuedMessageId ? [send.queuedMessageId] : [])]
    withdrawJournalConnectorReplies(db, target, ids, savedAt)
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
    if (send) {
      withdrawStopRejectedConnectorReplies(db, target, send, savedAt)
    }
  }
}
