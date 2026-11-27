// A request with a recorded outcome is never handed over again as new: each outcome writer reads
// its mail in the same write, so a handover that left it unread (a pointer) can't replay it on the
// next `check`. Two stay unread on purpose: a worker ask dropped with no reader, which a later
// coordinator can still answer, and a request whose chat continues after a usage limit, whose
// rerun still reads it.
import type { OrchestrationDb } from '../orchestration-db'

export function readSettledRequestMail(db: OrchestrationDb, messageId: string): void {
  db.markAsRead([messageId], { kind: 'orca' })
}

/** Requests settled before this rule, still unread: read once, when the schema reaches v53. */
export function readSettledRequestMailBackfill(db: OrchestrationDb): void {
  const settled = [
    ['bot_request_outcomes', 'outcome', 'SELECT message_id FROM bot_request_outcomes'],
    [
      'question_threads',
      'told',
      "SELECT message_id FROM question_threads WHERE told = 'unanswered'"
    ],
    [
      'remote_owned_questions',
      'ended',
      "SELECT message_id FROM remote_owned_questions WHERE ended = 'unanswered'"
    ]
  ] as const
  for (const [table, column, ids] of settled) {
    if (db.hasColumn(table, column)) {
      db.db.exec(
        `UPDATE messages SET read = 1, pointer_enter_pending = 0, pointer_pty_id = NULL,
           pointer_process_incarnation = NULL
         WHERE read = 0 AND id IN (${ids})`
      )
    }
  }
}
