import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'

export function registerJournalHostDatabaseTests(): void {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-host-'))
  })

  afterEach(async () => {
    await closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  describe('the shared connection', () => {
    it('refuses a transaction body that awaits', () => {
      const database = openTestJournalHostDatabase(root)
      expect(() => database.transaction(async () => undefined)).toThrow('must not await')
      expect(database.db.isTransaction).toBe(false)
    })
  })
}
