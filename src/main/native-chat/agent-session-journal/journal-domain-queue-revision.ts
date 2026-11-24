import type Database from '../../sqlite/sync-database'

type Target = { sessionId: string; epoch: string }

/** Several dependency changes in one source unit share its next event position. */
export function invalidateJournalDomainQueue(
  db: Database.Database,
  target: Target,
  sequence?: number
): void {
  db.prepare(`UPDATE journal_chat_state SET queue_revision=MAX(queue_revision,COALESCE(?,last_sequence+1))
    WHERE session_id=? AND epoch=?`).run(sequence ?? null, target.sessionId, target.epoch)
}

export function readJournalDomainQueueRevision(db: Database.Database, sessionId: string) {
  const head = db
    .prepare(`SELECT epoch,queue_revision
    FROM journal_chat_state WHERE session_id=? AND epoch IS NOT NULL`)
    .get(sessionId)
  if (!head) {
    throw new Error('queue revision targets a retired chat')
  }
  return {
    epoch: String(head.epoch),
    revision: Number(head.queue_revision)
  }
}
