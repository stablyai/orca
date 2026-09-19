import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'

export function journalMaterializationIdentity(db: Database.Database): string {
  const row = db.prepare('SELECT incarnation FROM journal_materialization WHERE id = 1').get()
  if (!row || typeof row.incarnation !== 'string') {
    throw new Error('journal_materialization_identity_unavailable')
  }
  return row.incarnation
}

/** Must run in the transaction that destroys journal positions. */
export function rotateJournalMaterializationIdentity(db: Database.Database): void {
  db.prepare('UPDATE journal_materialization SET incarnation = ? WHERE id = 1').run(randomUUID())
}
