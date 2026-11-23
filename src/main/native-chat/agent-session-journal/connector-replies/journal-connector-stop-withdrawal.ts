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

// The chat's unanswered connector rows, by the message that admitted or claimed them: one indexed
// read, so a chat with none (every local chat) does no more work. A continuation owns no rows but
// claims its cut's, which its withdrawal releases.
function openReplyMessageIds(db: Database.Database, target: Target): Set<string> {
  const ids = new Set<string>()
  for (const row of db
    .prepare(`SELECT message_id, claim_message_id FROM journal_connector_replies
    WHERE session_id=? AND outcome IS NULL AND epoch=?`)
    .all(target.sessionId, target.epoch)) {
    ids.add(String(row.message_id))
    if (row.claim_message_id != null) {
      ids.add(String(row.claim_message_id))
    }
  }
  return ids
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

/** Withdraws the rows of each send the saved person's Stop took back; only sends with open rows are read. */
function withdrawTakenBack(
  db: Database.Database,
  target: Target,
  sends: readonly (() => AgentJournalSubmission | undefined)[],
  savedAt: number
): void {
  const open = openReplyMessageIds(db, target)
  if (open.size === 0) {
    return
  }
  const stop = savedStop(db, target)?.event ?? null
  for (const read of sends) {
    const send = read()
    const ids = send ? rowIdsOf(send).filter((id) => open.has(id)) : []
    if (send && ids.length > 0 && personStopTookBack(send, stop)) {
      withdrawJournalConnectorReplies(db, target, ids, savedAt)
    }
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
    withdrawTakenBack(db, target, [() => send], savedAt)
  }
}

/** In a Stop's acceptance, after the Stop is saved: the queued sends it withdrew were saved before it. */
export function withdrawStopTakenBackReplies(
  db: Database.Database,
  target: Target,
  messageIds: readonly string[],
  savedAt: number
): void {
  if (messageIds.length > 0) {
    withdrawTakenBack(
      db,
      target,
      messageIds.map(
        (id) => () => readJournalDomainSubmissionAttempt(db, target, id, false)?.submission
      ),
      savedAt
    )
  }
}
