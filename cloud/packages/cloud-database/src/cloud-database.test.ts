import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openCloudDatabase, openInMemoryCloudDatabase } from './cloud-database.js'

const SCHEMA = ['CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, value BIGINT NOT NULL)']

describe('cloud database', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the SQLite file after the service and applies the given schema', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-database-'))
    dirs.push(dataDir)
    const database = await openCloudDatabase({ service: 'sample', schemaStatements: SCHEMA, dataDir })
    await database.transaction(async (tx) => {
      await tx.query('INSERT INTO items (id, value) VALUES (?, ?)', ['a', 1])
    })
    await database.close()
    expect(existsSync(join(dataDir, 'orca-sample.sqlite'))).toBe(true)

    const reader = await openCloudDatabase({
      service: 'sample',
      schemaStatements: SCHEMA,
      dataDir,
      readOnly: true
    })
    await expect(reader.query('SELECT id, value FROM items')).resolves.toEqual([{ id: 'a', value: 1 }])
    await reader.close()
  })

  it('adds a column on SQLite only while it is missing, so every boot can repeat it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-database-'))
    dirs.push(dataDir)
    const schema = [
      ...SCHEMA,
      'ALTER TABLE items ADD COLUMN IF NOT EXISTS note TEXT',
      'ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "Extra" TEXT'
    ]
    for (let boot = 0; boot < 2; boot++) {
      const database = await openCloudDatabase({ service: 'sample', schemaStatements: schema, dataDir })
      await database.query('INSERT INTO items (id, value, note) VALUES (?, ?, ?)', [`${boot}`, 1, 'n'])
      await database.close()
    }
  })

  it('rolls back a failed transaction in memory', async () => {
    const database = await openInMemoryCloudDatabase(SCHEMA)
    await expect(
      database.transaction(async (tx) => {
        await tx.query('INSERT INTO items (id, value) VALUES (?, ?)', ['a', 1])
        throw new Error('abort')
      })
    ).rejects.toThrow('abort')
    await expect(database.query('SELECT id FROM items')).resolves.toEqual([])
    await database.close()
  })
})
