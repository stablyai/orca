import { describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  ProfileStateIndeterminateWriteError,
  withProfileStateWriteTransaction
} from './profile-state-write-transaction'

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
  it.each([false, true])(
    'reports failed rollback as indeterminate after commit=%s',
    (commitFirst) => {
      const db = new Database(':memory:')
      db.exec('CREATE TABLE writes (id INTEGER)')
      const exec = db.exec.bind(db)
      const injected = vi.spyOn(db, 'exec').mockImplementation((sql) => {
        if (sql === 'ROLLBACK') {
          throw new Error('injected rollback failure')
        }
        if (sql === 'COMMIT') {
          if (commitFirst) {
            exec(sql)
          }
          throw new Error('injected commit failure')
        }
        exec(sql)
      })
      try {
        expect(() =>
          withProfileStateWriteTransaction(db, () => db.exec('INSERT INTO writes VALUES (1)'))
        ).toThrow(ProfileStateIndeterminateWriteError)
        expect(db.isTransaction).toBe(!commitFirst)
        if (db.isTransaction) {
          exec('ROLLBACK')
        }
        expect(db.prepare('SELECT COUNT(*) AS count FROM writes').get()).toMatchObject({
          count: commitFirst ? 1 : 0
        })
      } finally {
        injected.mockRestore()
        db.close()
      }
    }
  )
})
