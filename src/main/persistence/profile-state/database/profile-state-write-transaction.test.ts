import { describe, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { withProfileStateWriteTransaction } from './profile-state-write-transaction'

describe('profile state write transaction ownership', () => {
  // Reproduce SQLITE_FULL auto-rollback: COMMIT throws errcode 13, transaction ends, rows stay unchanged.

  it('rolls back a failed deferred commit and leaves the connection usable', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
      `)
      expect(() =>
        withProfileStateWriteTransaction(db, () => {
          db.exec('INSERT INTO child VALUES (1)')
        })
      ).toThrow(/FOREIGN KEY/)
      expect(db.isTransaction).toBe(false)
      expect(db.prepare('SELECT COUNT(*) AS count FROM child').get()).toMatchObject({ count: 0 })
      withProfileStateWriteTransaction(db, () => {
        db.exec('INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1)')
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM child').get()).toMatchObject({ count: 1 })
    } finally {
      db.close()
    }
  })
})
