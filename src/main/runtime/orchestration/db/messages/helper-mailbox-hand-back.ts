import type { OrchestrationDb } from '../orchestration-db'

/** Mail a settling helper creator never handled, now owned by its Run's mailbox. */
export type MailHandBack = { mailbox: string; messageIds: string[]; types: string[] }

/**
 * A settled worker no longer reads its mailbox, so its helpers' unread reports and unanswered
 * questions (even ones it read) become the Run coordinator's, delivered as if they just arrived.
 */
export function handHelperMailToRun(db: OrchestrationDb, dispatchId: string): void {
  // Why: every settlement runs this, so read only the Run, not the whole dispatch row.
  const runId = db.db
    .prepare('SELECT run_id FROM dispatch_contexts WHERE id = ?')
    .get(dispatchId)?.run_id
  if (typeof runId !== 'string') {
    return
  }
  const mailbox = `dispatch:${dispatchId}`
  // Why: the recipient mailbox is the ownership fact; report payloads and senders are optional.
  const rows = db.db
    .prepare(
      `SELECT id, type FROM messages
       WHERE run_id = ? AND to_handle = ? AND (
         (read = 0 AND delivery_contract = 'current_delivery'
           AND type IN ('worker_done', 'escalation', 'status'))
         OR id IN (
           SELECT message_id FROM question_threads WHERE run_id = ? AND status = 'pending'))`
    )
    .all(runId, mailbox, runId)
  if (
    rows.length === 0 ||
    !db.db
      .prepare(
        'SELECT 1 FROM dispatch_contexts WHERE creator_dispatch_id = ? AND run_id = ? LIMIT 1'
      )
      .get(dispatchId, runId)
  ) {
    return
  }
  const handBack: MailHandBack = {
    mailbox: `run:${runId}`,
    messageIds: rows.map((row) => String(row.id)),
    types: [...new Set(rows.map((row) => String(row.type)))]
  }
  // Why: the old mailbox's delivery stamp and pointer reservation would hide the rows from the Run.
  db.db
    .prepare(
      `UPDATE messages
       SET to_handle = ?, read = 0, delivered_at = NULL, pointer_enter_pending = 0,
           pointer_pty_id = NULL, pointer_process_incarnation = NULL
       WHERE id IN (SELECT value FROM json_each(?))`
    )
    .run(handBack.mailbox, JSON.stringify(handBack.messageIds))
  db.fenceUnacknowledgedMailboxDeliveries(mailbox)
  db.pendingMailHandBacks.push(handBack)
  if (db.pendingMailHandBacks.length === 1) {
    // Why: settlements are synchronous, so this runs after the outermost COMMIT or ROLLBACK.
    queueMicrotask(() => {
      for (const pending of db.pendingMailHandBacks.splice(0)) {
        db.mailHandBackListener?.(pending)
      }
    })
  }
}

/** The types of handed-back rows the Run still owes attention to, read after the settlement. */
export function committedHandBackTypes(db: OrchestrationDb, handBack: MailHandBack): string[] {
  return db.db
    .prepare(
      `SELECT DISTINCT type FROM messages
       WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
         AND id IN (SELECT value FROM json_each(?))
         AND (type <> 'question'
           OR id IN (SELECT message_id FROM question_threads WHERE status = 'pending'))`
    )
    .all(handBack.mailbox, JSON.stringify(handBack.messageIds))
    .map((row) => String(row.type))
}

/** The Run mail a helper creator's settlement may have handed back that still owes attention. */
export function handBackReplayTargets(db: OrchestrationDb, dispatchId: string) {
  return db.db
    .prepare(
      `SELECT DISTINCT m.to_handle AS mailbox, m.type FROM dispatch_contexts AS d
       JOIN messages AS m ON m.to_handle = 'run:' || d.run_id
       WHERE d.id = ? AND m.read = 0 AND m.delivery_contract = 'current_delivery'
         AND EXISTS (SELECT 1 FROM dispatch_contexts AS h
           WHERE h.creator_dispatch_id = d.id AND h.run_id = d.run_id)
         AND (m.type IN ('worker_done', 'escalation', 'status') OR (m.type = 'question'
           AND m.id IN (SELECT message_id FROM question_threads
             WHERE run_id = d.run_id AND status = 'pending')))`
    )
    .all(dispatchId)
    .map((row) => ({ to: String(row.mailbox), type: String(row.type) }))
}
