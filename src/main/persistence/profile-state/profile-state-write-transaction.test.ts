import { describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { withProfileStateWriteTransaction } from './profile-state-write-transaction'

describe('profile state write transaction ownership', () => {
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

  it('leaves a caller-owned transaction intact when a nested write is refused', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE pending (id INTEGER); BEGIN; INSERT INTO pending VALUES (1)')
      expect(() =>
        withProfileStateWriteTransaction(db, () => db.exec('DELETE FROM pending'))
      ).toThrow(/idle database/)
      expect(db.isTransaction).toBe(true)
      db.exec('COMMIT')
      expect(db.prepare('SELECT id FROM pending').get()).toMatchObject({ id: 1 })
    } finally {
      db.close()
    }
  })
})
