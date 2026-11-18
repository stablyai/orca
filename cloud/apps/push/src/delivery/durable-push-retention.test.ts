import { afterEach, expect, it } from 'vitest'
import {
  cleanupDurablePushFixtures,
  durablePushTestDatabaseUrl,
  fixture,
  within
} from './durable-push-store.test-fixture.js'

afterEach(cleanupDurablePushFixtures)

const retentionTables = [
  {
    table: 'push_dismissed_events',
    columns: 'host_fingerprint, notification_epoch, notification_id, notification_seq, created_at',
    values: "'host', 'epoch-' || n, 'notification', n, created_at"
  },
  {
    table: 'push_event_recipients',
    columns: 'event_id, registration_id, created_at',
    values: "'event', 'phone-' || n, created_at"
  },
  {
    table: 'push_events',
    columns: 'event_id, host_fingerprint, kind, fingerprint, created_at, expires_at',
    values: "'event-' || n, 'host', 'alert', 'fingerprint', created_at, created_at"
  }
] as const

it.skipIf(!durablePushTestDatabaseUrl).each(retentionTables)(
  'skips a locked oldest $table row until its transaction releases it',
  async ({ table, columns, values }) => {
    const { db, store, clock } = await fixture()
    const cutoff = clock() - 24 * 60 * 60_000
    await db.query(
      `INSERT INTO ${table} (${columns})
     WITH rows(n, created_at) AS (VALUES (1, ?::bigint), (2, ?::bigint), (3, ?::bigint))
     SELECT ${values} FROM rows`,
      [cutoff - 2, cutoff - 1, cutoff]
    )
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holding = db.transaction(async (tx) => {
      await tx.query(`SELECT * FROM ${table} WHERE created_at = ? FOR UPDATE`, [cutoff - 2])
      locked.resolve()
      await release.promise
    })
    try {
      await locked.promise
      expect(await within(store.prune(), 1000)).toEqual({ deleted: 1, saturated: false })
      const preserved = await db.query(`SELECT created_at FROM ${table} ORDER BY created_at`)
      expect(preserved.map((row) => Number(row.created_at))).toEqual([cutoff - 2, cutoff])
    } finally {
      release.resolve()
      await holding
    }
    expect(await store.prune()).toEqual({ deleted: 1, saturated: false })
    const preserved = await db.query(`SELECT created_at FROM ${table}`)
    expect(preserved.map((row) => Number(row.created_at))).toEqual([cutoff])
  }
)
