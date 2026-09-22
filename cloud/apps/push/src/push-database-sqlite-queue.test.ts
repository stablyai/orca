import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { openPushDatabase } from './push-database.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('releases queued operations after SQLite refuses to begin a transaction', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-push-locked-db-'))
  temporaryDirectories.push(dataDir)
  const database = await openPushDatabase({ dataDir })
  const blocker = new DatabaseSync(join(dataDir, 'orca-push.sqlite'))
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      blocker.exec('BEGIN IMMEDIATE')
      await expect(database.transaction(async () => {})).rejects.toThrow('database is locked')
      blocker.exec('ROLLBACK')
      expect(
        await database.transaction((transaction) => transaction.query('SELECT 1 AS value'))
      ).toEqual([{ value: 1 }])
      expect(await database.query('SELECT 2 AS value')).toEqual([{ value: 2 }])
    }
  } finally {
    blocker.close()
    await database.close()
  }
})
