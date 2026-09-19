import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openRelayDatabase } from './database.js'
import { POSTGRES_STATEMENT_STATS_MIGRATION } from './postgres-statement-stats.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

describePostgres('optional PostgreSQL statement statistics', () => {
  let admin: pg.Client
  let preloaded: boolean
  const databases: string[] = []
  const roles: string[] = []

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
    const result = await admin.query<{ loaded: boolean }>(
      `SELECT 'pg_stat_statements' = ANY(string_to_array(
         replace(current_setting('shared_preload_libraries'), ' ', ''), ','
       )) AS loaded`
    )
    preloaded = result.rows[0]!.loaded
  })

  afterAll(async () => {
    for (const database of databases) await admin.query(`DROP DATABASE IF EXISTS ${database}`)
    for (const role of roles) await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  })

  async function freshDatabase(): Promise<string> {
    const name = `relay_stats_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE ${name}`)
    databases.push(name)
    const url = new URL(databaseUrl!)
    url.pathname = `/${name}`
    return url.toString()
  }

  async function connect(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url, statement_timeout: 2_000 })
    await client.connect()
    return client
  }

  async function installed(client: pg.Client): Promise<boolean> {
    const result = await client.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS present`
    )
    return result.rows[0]!.present
  }

  it('exposes an existing collector idempotently, and skips servers without one', async () => {
    const url = await freshDatabase()
    const database = await openRelayDatabase({ databaseUrl: url, dataDir: '' })
    await database.close()
    const client = await connect(url)
    try {
      expect(await installed(client)).toBe(preloaded)
      if (preloaded) {
        const before = await client.query('SELECT stats_reset FROM public.pg_stat_statements_info')
        await client.query(POSTGRES_STATEMENT_STATS_MIGRATION)
        const after = await client.query('SELECT stats_reset FROM public.pg_stat_statements_info')
        expect(after.rows).toEqual(before.rows)
        await client.query('SELECT calls, wal_bytes, shared_blks_dirtied FROM public.pg_stat_statements LIMIT 1')
      } else {
        await client.query(POSTGRES_STATEMENT_STATS_MIGRATION)
        expect(await installed(client)).toBe(false)
      }
    } finally {
      await client.end()
    }
  })

  it.each([false, true])('tolerates missing extension privileges (read settings: %s)', async (readSettings) => {
    const client = await connect(await freshDatabase())
    const role = `relay_stats_role_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE ROLE ${role}`)
    roles.push(role)
    if (readSettings) await admin.query(`GRANT pg_read_all_settings TO ${role}`)
    try {
      await client.query(`SET ROLE ${role}`)
      await client.query(POSTGRES_STATEMENT_STATS_MIGRATION)
      expect(await installed(client)).toBe(false)
      expect((await client.query<{ value: number }>('SELECT 42 AS value')).rows[0]!.value).toBe(42)
    } finally {
      await client.end()
    }
  })

  it('serializes concurrent catalog creation across directors', async () => {
    const url = await freshDatabase()
    const clients = await Promise.all(Array.from({ length: 5 }, async () => await connect(url)))
    try {
      await Promise.all(clients.map(async (client) => await client.query(POSTGRES_STATEMENT_STATS_MIGRATION)))
      expect(await installed(clients[0]!)).toBe(preloaded)
    } finally {
      await Promise.all(clients.map(async (client) => await client.end()))
    }
  })

  it('yields to an in-progress installer instead of blocking startup', async () => {
    const url = await freshDatabase()
    const owner = await connect(url)
    const contender = await connect(url)
    try {
      await owner.query('BEGIN')
      await owner.query(`SELECT pg_advisory_xact_lock(hashtext('orca-relay'), hashtext('statement-stats'))`)
      await contender.query(POSTGRES_STATEMENT_STATS_MIGRATION)
      expect(await installed(contender)).toBe(false)
      await owner.query('COMMIT')
      await contender.query(POSTGRES_STATEMENT_STATS_MIGRATION)
      expect(await installed(contender)).toBe(preloaded)
    } finally {
      await owner.end()
      await contender.end()
    }
  })
})
