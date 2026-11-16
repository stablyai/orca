import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

describePostgres('PostgreSQL session terminated by the server', () => {
  let database: RelayDatabase
  let admin: pg.Client

  beforeAll(async () => {
    // One pooled client: the next caller gets the terminated one unless it was destroyed.
    database = await openRelayDatabase({ databaseUrl, dataDir: '', poolMax: 1 })
    admin = new pg.Client({ connectionString: databaseUrl })
    await admin.connect()
  })

  afterAll(async () => {
    await admin.end()
    await database.close()
  })

  it('serves the next caller a live session after pg_terminate_backend', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const failure = await database
        .transaction(async (tx) => {
          const [row] = await tx.query('SELECT pg_backend_pid() AS pid')
          await admin.query('SELECT pg_terminate_backend($1)', [row?.pid])
          await tx.query('SELECT 1')
        })
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)

      await expect(database.query('SELECT 1 AS ok')).resolves.toEqual([{ ok: 1 }])
    } finally {
      vi.restoreAllMocks()
    }
  })
})
