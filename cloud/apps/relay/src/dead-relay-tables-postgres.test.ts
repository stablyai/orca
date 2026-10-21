import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { openRelayDatabase } from './database.js'

// Three tables were created at every boot and never written. The schema stops creating them, and
// a database that already has them must still boot, because they stay until a separate drop.
const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const schema = 'relay_dead_tables_test'
const DEAD_TABLES = [
  'relay_confirmable_splices',
  'relay_cell_drain_attempts',
  'relay_migration_leases'
]

function scopedUrl(): string {
  const url = new URL(databaseUrl!)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

async function onScoped<T>(operation: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: scopedUrl() })
  await client.connect()
  try {
    return await operation(client)
  } finally {
    await client.end()
  }
}

async function resetSchema(): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await client.query(`CREATE SCHEMA ${schema}`)
  } finally {
    await client.end()
  }
}

async function existingDeadTables(): Promise<string[]> {
  return await onScoped(async (client) => {
    const rows = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = ANY($2) ORDER BY table_name`,
      [schema, DEAD_TABLES]
    )
    return rows.rows.map((row) => String(row.table_name))
  })
}

describePostgres('removed relay tables against PostgreSQL', () => {
  afterAll(async () => {
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await client.end()
  })

  it('does not create the removed tables on a fresh database', async () => {
    await resetSchema()
    const database = await openRelayDatabase({ databaseUrl: scopedUrl(), dataDir: '' })
    await database.close()

    expect(await existingDeadTables()).toEqual([])
  })

  it('boots on a database an older image created, leaving those tables alone', async () => {
    await resetSchema()
    await onScoped(async (client) => {
      await client.query(`CREATE TABLE relay_confirmable_splices (basis_conn_id TEXT PRIMARY KEY)`)
      await client.query(`CREATE TABLE relay_cell_drain_attempts (cell_id TEXT PRIMARY KEY)`)
      await client.query(`CREATE TABLE relay_migration_leases (user_id TEXT NOT NULL)`)
    })

    const database = await openRelayDatabase({ databaseUrl: scopedUrl(), dataDir: '' })
    await database.close()

    expect(await existingDeadTables()).toEqual([...DEAD_TABLES].sort())
  })
})
