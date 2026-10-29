import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openCloudDatabase, type CloudDatabase } from '@orca-cloud/cloud-database'
import { requireSchemaLockTarget } from '@orca-cloud/postgres-schema'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { connectorBootStatements } from './connector-database.js'
import { connectorSchemaBaseline } from './connector-schema-baseline.test-fixture.js'

const testDatabaseUrl = process.env.ORCA_CONNECTOR_TEST_DATABASE_URL

type Engine = 'sqlite' | 'postgres'
type Store = { databaseUrl?: string; dataDir: string }

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function freshStore(engine: Engine): Promise<Store> {
  if (engine === 'sqlite') {
    const dataDir = mkdtempSync(join(tmpdir(), 'connector-schema-'))
    cleanups.push(async () => rmSync(dataDir, { recursive: true, force: true }))
    return { dataDir }
  }
  const admin = new pg.Client({ connectionString: testDatabaseUrl })
  await admin.connect()
  const schema = `connector_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  cleanups.push(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  })
  const url = new URL(testDatabaseUrl!)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return { databaseUrl: url.toString(), dataDir: '' }
}

// One boot per list, through the same path a deploy takes; returns the catalog it left.
async function boot(store: Store, ...lists: string[][]): Promise<string[]> {
  let database: CloudDatabase | undefined
  for (const schemaStatements of lists) {
    await database?.close()
    database = await openCloudDatabase({ ...store, service: 'connector', schemaStatements })
  }
  try {
    return await catalog(database!)
  } finally {
    await database!.close()
  }
}

async function catalog(database: CloudDatabase): Promise<string[]> {
  if (database.dialect === 'postgres') {
    const rows = await database.query(
      `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' ||
              COALESCE(column_default, '') AS entry
         FROM information_schema.columns WHERE table_schema = current_schema()
       UNION ALL
       SELECT regexp_replace(indexdef, ' ON \\S+\\.', ' ON ') FROM pg_indexes
        WHERE schemaname = current_schema()
       UNION ALL
       SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
         FROM pg_constraint WHERE connamespace = current_schema()::regnamespace
       ORDER BY 1`
    )
    return rows.map((row) => String(row.entry))
  }
  // SQLite rewrites a table's stored CREATE text on ADD COLUMN, so it compares like a fresh one.
  const objects = await database.query(
    'SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name'
  )
  return objects.map((object) => String(object.sql))
}

describe.each<Engine>(testDatabaseUrl ? ['sqlite', 'postgres'] : ['sqlite'])(
  'connector schema upgrade on %s',
  (engine) => {
    it('upgrades the shipped baseline to the schema a fresh database gets', async () => {
      const fresh = await boot(await freshStore(engine), connectorBootStatements())
      const upgraded = await boot(
        await freshStore(engine),
        connectorSchemaBaseline(),
        connectorBootStatements()
      )
      expect(upgraded).toEqual(fresh)
      expect(fresh.length).toBeGreaterThan(0)
    })

    it.each([
      ['a column', ',\n  probe TEXT,'],
      ['a constraint', ' UNIQUE,']
    ])('catches %s added inside a shipped CREATE TABLE', async (_, edit) => {
      const edited = connectorBootStatements().map((statement) =>
        statement.replace('host_name TEXT NOT NULL,', `host_name TEXT NOT NULL${edit}`)
      )
      const fresh = await boot(await freshStore(engine), edited)
      const upgraded = await boot(await freshStore(engine), connectorSchemaBaseline(), edited)
      expect(upgraded).not.toEqual(fresh)
    })
  }
)

it('gives every boot statement a shape the Postgres applier can read', () => {
  // The applier throws at boot on an ALTER or index it cannot parse; catch that without Postgres.
  for (const statement of connectorBootStatements()) {
    expect(() => requireSchemaLockTarget(statement)).not.toThrow()
  }
})
