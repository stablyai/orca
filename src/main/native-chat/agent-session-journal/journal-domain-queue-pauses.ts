import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalQueuePauseMarks } from './queued-messages/queued-message-pause-marks'
import {
  createQueuePauseContext,
  type QueuePauseContext
} from './queued-messages/queued-message-pause'
import { JOURNAL_SQL_ACCEPTED_INPUT_COLUMNS } from './journal-sql-accepted-inputs'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { readJournalDomainQueueFailure } from './journal-domain-queue-failures'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'

type Target = { sessionId: string; epoch: string }

/** Clear membership is selected only for the caller's bounded current-card page. */
export function readJournalDomainQueuePauseContext(
  db: Database.Database,
  target: Target,
  reopenFloor: AgentJournalCursor | null,
  messageIds: readonly string[],
  snapshot?: { head: SqliteRow; clearMembers: ReadonlySet<string> }
): QueuePauseContext {
  const prefix = [target.sessionId, target.epoch] as const
  const head =
    snapshot?.head ??
    db
      .prepare(`SELECT queue_latest_stop_json, queue_manual_stop_json,
    queue_resumed_sequence, queue_reopened_sequence, queue_clear_sequence,
    queue_clear_operation_id, queue_clear_lifted, ${JOURNAL_SQL_ACCEPTED_INPUT_COLUMNS}
    FROM journal_chat_state head
    WHERE session_id=? AND epoch=?`)
      .get(...prefix)
  if (!head) {
    throw new Error('journal queue pause targets a retired chat epoch')
  }
  const marks: JournalQueuePauseMarks = {
    latestStop:
      head.queue_latest_stop_json === null ? null : JSON.parse(String(head.queue_latest_stop_json)),
    ...(head.queue_manual_stop_json === null
      ? {}
      : { manualStop: JSON.parse(String(head.queue_manual_stop_json)) }),
    resumedSequence: Number(head.queue_resumed_sequence),
    reopenedSequence: Number(head.queue_reopened_sequence),
    ...(head.queue_clear_operation_id === null
      ? {}
      : {
          cleared: {
            sequence: Number(head.queue_clear_sequence),
            operationId: String(head.queue_clear_operation_id),
            messageIds: [],
            ...(head.queue_clear_lifted ? { lifted: true as const } : {})
          }
        })
  }
  const clearMembers =
    snapshot?.clearMembers ??
    new Set(
      db
        .prepare(`SELECT member.message_id FROM json_each(?) wanted
    CROSS JOIN journal_queue_clear_members member WHERE member.session_id=? AND member.epoch=?
      AND member.message_id=wanted.value`)
        .all(JSON.stringify(messageIds), ...prefix)
        .map((row) => String(row.message_id))
    )
  const accepted = {
    latestAcceptedTurnSequence: Number(head.latest_accepted ?? 0),
    latestPersonAcceptedSequence: Number(head.latest_person_accepted ?? 0)
  }
  return createQueuePauseContext(
    {
      epoch: target.epoch,
      marks,
      ...accepted,
      latestPersonAcceptedTurnSequence: accepted.latestPersonAcceptedSequence,
      failedAt: readJournalDomainQueueFailure(db, target),
      reopenFloor
    },
    clearMembers
  )
}

/** The command appends its own reopen event before the admission event. */
export function writeJournalDomainQueueReopenMark(
  db: Database.Database,
  target: Target,
  sequence: number,
  since: number
): void {
  if (!db.isTransaction) {
    throw new Error('journal queue reopen requires its writer transaction')
  }
  const changed = db
    .prepare(`UPDATE journal_chat_state
    SET queue_reopened_sequence=MAX(queue_reopened_sequence,?) WHERE session_id=? AND epoch=?`)
    .run(since > 0 && since <= sequence ? since : sequence, target.sessionId, target.epoch)
  if (Number(changed.changes) !== 1) {
    throw new Error('journal queue reopen targets a retired chat epoch')
  }
  invalidateJournalDomainQueue(db, target, sequence)
}
