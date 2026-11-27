// A request whose settled state is written (an outcome, an answer, a notice, a close) is never handed
// over again as new: every such write goes through `settleRequests`, which reads its mail in the same
// transaction, so a handover that left it unread (a pointer) can't replay it on the next `check`.
// Two stay unread on purpose, by passing 'keep-unread': a worker ask dropped with no reader, which a
// later coordinator can still answer, and a request whose chat continues after a usage limit, whose
// rerun still reads it.
import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'

/** Who reads the settled mail: its answer, Orca for any other ending, or no one yet. */
export type SettledRequestRead = 'reply' | 'orca' | 'keep-unread'

/** Runs `settle`, the write that settles requests and returns the ids it settled, and reads their
 *  mail in the same transaction. */
export function settleRequests(
  db: OrchestrationDb,
  read: SettledRequestRead,
  settle: () => string[]
): string[] {
  return runLifecycleWriteTransaction(db.db, 'settle_requests', () => {
    const settled = settle()
    if (settled.length > 0 && read !== 'keep-unread') {
      db.markAsRead(settled, { kind: read })
    }
    return settled
  })
}

/** The same rule, once, for requests settled unread before it: when the schema reaches v53. */
export function readSettledRequestMailBackfill(db: OrchestrationDb): void {
  const settled = [
    ['bot_request_outcomes', 'outcome', 'SELECT message_id FROM bot_request_outcomes'],
    [
      'question_threads',
      'told',
      `SELECT message_id FROM question_threads
       WHERE told = 'unanswered' OR status IN ('answered', 'closed')`
    ],
    [
      'remote_owned_questions',
      'ended',
      "SELECT message_id FROM remote_owned_questions WHERE ended IN ('answered', 'unanswered')"
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
