import { randomUUID } from 'node:crypto'
import type Database from '../../../../sqlite/sync-database'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'

/** An incarnation survives reopen, but never a replacement or source-history reset. */
export function ensureMailSourceOrder(db: Database.Database): void {
  runLifecycleWriteTransaction(db, 'mail_source_order', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS mail_source_incarnation (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), incarnation TEXT NOT NULL
  )`)
    db.prepare('INSERT OR IGNORE INTO mail_source_incarnation VALUES (1, ?)').run(randomUUID())
    if (
      !db
        .prepare('PRAGMA table_info(messages)')
        .all()
        .some((row) => row.name === 'ordering_origin')
    ) {
      db.exec('ALTER TABLE messages ADD COLUMN ordering_origin TEXT')
    }
  })
}

export function mailSourceIncarnation(db: Database.Database): string {
  const value = db
    .prepare('SELECT incarnation FROM mail_source_incarnation WHERE singleton = 1')
    .get()?.incarnation
  if (typeof value !== 'string' || !value) {
    throw new Error('mail source identity unavailable')
  }
  return value
}

export function rotateMailSourceIncarnation(db: Database.Database): void {
  db.prepare('UPDATE mail_source_incarnation SET incarnation = ? WHERE singleton = 1').run(
    randomUUID()
  )
}
