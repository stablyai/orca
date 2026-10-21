import { afterAll, describe, expect, it } from 'vitest'
import type { PostgresDatabase } from './database.js'
import { isPostgresPoolConnectTimeout } from './postgres-pool-pressure.js'
import { openDelayedPostgresDatabase } from './test-fixtures/delayed-postgres-database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

// The 2026-10-06 asia-east2 shape at test scale: a reconnect herd far wider
// than the pool, every statement paying a cross-region round trip, and a
// control renewal arriving behind it.
describePostgres('PostgreSQL priority lane under a reconnect herd', () => {
  const databases: PostgresDatabase[] = []
  const delay = { enabled: true, delayMs: 400 }

  afterAll(async () => {
    delay.enabled = false
    for (const database of databases) await database.close()
  })

  it('renews ahead of the herd while queued general work times out', async () => {
    const database = openDelayedPostgresDatabase(databaseUrl!, delay, 4)
    databases.push(database)
    const herd = Array.from({ length: 40 }, () =>
      database.query('SELECT 1').then(
        () => 'ok',
        (error: unknown) => (isPostgresPoolConnectTimeout(error) ? 'timeout' : 'other')
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const startedAt = performance.now()
    const general = database
      .query('SELECT 1 AS renewed')
      .catch(() => undefined)
      .then(() => performance.now() - startedAt)
    const renewed = await database.queryPriority('SELECT 1 AS renewed')
    const renewedMs = performance.now() - startedAt

    expect(renewed).toEqual([{ renewed: 1 }])
    // The next released connection plus one statement, never a turn in the herd's queue.
    expect(renewedMs).toBeLessThan(1_500)
    // The same statement on the general lane waits out the herd's acquire timeout.
    expect(await general).toBeGreaterThan(1_900)
    const outcomes = await Promise.all(herd)
    expect(outcomes.filter((outcome) => outcome === 'timeout').length).toBeGreaterThan(20)
    expect(outcomes).not.toContain('other')
  }, 15_000)
})
