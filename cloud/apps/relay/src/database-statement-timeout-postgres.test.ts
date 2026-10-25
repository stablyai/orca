import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const applicationName = 'orca-relay/statement-timeout-postgres'

describePostgres('PostgreSQL statement deadline', () => {
  const databases: RelayDatabase[] = []

  beforeAll(async () => {
    databases.push(await openRelayDatabase({ databaseUrl, dataDir: '' }))
  })

  afterAll(async () => {
    for (const database of databases) await database.close()
  })

  // Why: a real 57014 aborts the transaction exactly as a lock timeout does. If
  // it escapes the bounded retry it becomes a failed assignment instead of a
  // slow one.
  it('retries a transaction after a real statement timeout', async () => {
    const database = await openRelayDatabase({ databaseUrl, dataDir: '', statementTimeoutMs: 300 })
    databases.push(database)
    let attempts = 0

    const result = await database.transaction(async (transaction) => {
      attempts += 1
      if (attempts === 1) await transaction.query(`SELECT pg_sleep(2)`)
      return attempts
    })

    expect(result).toBe(2)
  }, 15_000)

  // CREATE INDEX IF NOT EXISTS still queues table locks before checking existence; pg_class precheck avoids blocking writers on migrated databases.
  it('boots without queueing behind a held ACCESS EXCLUSIVE lock', async () => {
    let releaseTable!: () => void
    const tableReleased = new Promise<void>((resolve) => {
      releaseTable = resolve
    })
    let tableHeld!: () => void
    const tableHeldPromise = new Promise<void>((resolve) => {
      tableHeld = resolve
    })
    const holder = databases[0]!.transaction(async (transaction) => {
      await transaction.query(`LOCK TABLE relay_invites IN ACCESS EXCLUSIVE MODE`)
      tableHeld()
      await tableReleased
    })
    try {
      await tableHeldPromise

      // Resolving while the lock is still held is the whole proof: a statement that queued would hit
      // the schema connection's 1s lock_timeout and fail the boot, which is no longer retried.
      const database = await openRelayDatabase({
        databaseUrl,
        dataDir: '',
        applicationName,
        // Far too short for a blocked DDL; the serving pool wears it, the schema
        // connection must not.
        statementTimeoutMs: 200
      })
      databases.push(database)
      const waiting = await databases[0]!.query(
        `SELECT count(*) AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND application_name = ?`,
        [`${applicationName}/schema`]
      )
      expect(Number(waiting[0]!.waiting)).toBe(0)

      // The serving pool still carries the short deadline it was opened with.
      expect(
        await database.query(`SELECT current_setting('statement_timeout') AS statement_timeout`)
      ).toEqual([{ statement_timeout: '200ms' }])
    } finally {
      releaseTable()
      await holder
    }
  }, 15_000)
})
