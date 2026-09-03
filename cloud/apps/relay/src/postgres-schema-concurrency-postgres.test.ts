import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const schema = 'relay_schema_concurrency_test'

describePostgres('PostgreSQL schema concurrency', () => {
  let scopedUrl = ''

  beforeAll(async () => {
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await client.query(`CREATE SCHEMA ${schema}`)
    } finally {
      await client.end()
    }
    const url = new URL(databaseUrl!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    scopedUrl = url.toString()
  })

  afterAll(async () => {
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await client.end()
    }
  })

  it('opens five directors when one new table is absent', async () => {
    const initial = await openRelayDatabase({ databaseUrl: scopedUrl, dataDir: '' })
    await initial.query(`DROP TABLE relay_cell_legacy_fence_adoptions`)
    await initial.close()

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, async (): Promise<RelayDatabase> =>
        await openRelayDatabase({ databaseUrl: scopedUrl, dataDir: '' })
      )
    )
    const databases = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    try {
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
    } finally {
      await Promise.all(databases.map(async (database) => await database.close()))
    }
  })
})
