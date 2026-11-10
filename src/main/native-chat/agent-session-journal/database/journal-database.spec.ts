import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'

import { journalDatabasePath } from './journal-host-database'

export function registerJournalDatabaseTests(): void {
  let root: string
  let dbPath: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-db-'))
    dbPath = journalDatabasePath(root)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  describe('schema creation', () => {
    it('publishes no table until the version bump commits with it', () => {
      const original = Database.prototype.pragma
      const pragma = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
        this: Database.Database,
        sql: string,
        options?: { simple?: boolean }
      ) {
        if (sql.startsWith('user_version =')) {
          throw new Error('crash before the version is published')
        }
        return original.call(this, sql, options)
      })

      expect(() => openJournalDatabase(dbPath)).toThrow('crash before the version is published')
      pragma.mockRestore()

      const inspected = new Database(dbPath)
      try {
        expect(inspected.pragma('user_version', { simple: true })).toBe(0)
        expect(
          inspected
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_rows'"
            )
            .get()
        ).toBeUndefined()
      } finally {
        inspected.close()
      }
    })
  })
}
