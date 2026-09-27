import { afterEach, expect, it } from 'vitest'
import type { PushDatabase } from './push-database.js'
import {
  DELIVERY_LEASE_MS,
  DurablePushStore,
  PRUNE_BATCH_ROWS,
  PRUNE_MAX_BATCHES
} from './durable-push-store.js'
import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import {
  CANDIDATE_SQL,
  cleanupDurablePushFixtures,
  DEVICE_HEAD_SQL,
  durablePushTestDatabaseUrl,
  fixture,
  notification,
  pauseAfter,
  within
} from './durable-push-store.test-fixture.js'

afterEach(cleanupDurablePushFixtures)

async function batchCount(db: PushDatabase): Promise<number> {
  const [row] = await db.query('SELECT COUNT(*) AS total FROM push_delivery_batches')
  return Number(row?.total ?? 0)
}

it('leases exactly one delivery per device across concurrent claimers', async () => {
  const { db, store, clock, advance } = await fixture()
  for (let seq = 1; seq <= 5; seq++) {
    await store.accept('host', 'phone', notification(seq))
    advance(1)
  }
  const claims = await Promise.all(
    Array.from({ length: 8 }, () => new DurablePushStore(db, clock).claim())
  )
  const leased = claims.filter((claim) => claim !== null)
  expect(leased).toHaveLength(1)
  expect(leased[0]?.notification.notificationSeq).toBe(1)
})

it.skipIf(!durablePushTestDatabaseUrl)(
  'does not lease the row behind a head another claimer holds',
  async () => {
    const { db, store, clock, advance } = await fixture()
    await store.accept('host', 'phone', notification(1))
    advance(1)
    await store.accept('host', 'phone', notification(2))
    const paused = pauseAfter(db)
    const first = new DurablePushStore(paused.wrapped, clock).claim()
    await paused.atCandidate
    try {
      expect(await within(store.claim(), 2_000)).toBeNull()
    } finally {
      paused.release()
    }
    expect((await first)?.notification.notificationSeq).toBe(1)
    expect(await store.claim()).toBeNull()
  }
)

it.skipIf(!durablePushTestDatabaseUrl)(
  'claims another device while one claim transaction is still open',
  async () => {
    const { db, store, clock, advance } = await fixture()
    await store.accept('host', 'phone-a', notification(1))
    advance(1)
    await store.accept('host', 'phone-b', notification(2))
    const paused = pauseAfter(db)
    const first = new DurablePushStore(paused.wrapped, clock).claim()
    await paused.atCandidate
    try {
      expect((await within(store.claim(), 2_000))?.registrationId).toBe('phone-b')
    } finally {
      paused.release()
    }
    expect((await first)?.registrationId).toBe('phone-a')
  }
)

it.skipIf(!durablePushTestDatabaseUrl)(
  'keeps a device exclusive when an earlier-sorting row lands mid-claim',
  async () => {
    const { db, store, clock } = await fixture()
    await store.accept('host', 'phone', notification(1))
    const paused = pauseAfter(db, DEVICE_HEAD_SQL)
    const first = new DurablePushStore(paused.wrapped, clock).claim()
    await paused.atCandidate
    try {
      // Another instance with a slower clock queues a row that now sorts first.
      await db.query(
        `INSERT INTO push_delivery_batches(batch_id, host_fingerprint, registration_id, kind, payload_json, state, due_at, expires_at, lease_until, attempts, created_at)
        VALUES ('skewed', 'host', 'phone', 'alert', ?, 'pending', ?, ?, 0, 0, ?)`,
        [JSON.stringify(notification(2)), clock() - 10, clock() + 60_000, clock() - 10]
      )
      expect(await within(store.claim(), 2_000)).toBeNull()
    } finally {
      paused.release()
    }
    expect((await first)?.notification.notificationSeq).toBe(1)
  }
)

// Only the TTL term keeps the candidate scan off an unpruned backlog; expires_at is not indexed first.
it('never scans rows due before the notification TTL window', async () => {
  const { db, store, clock } = await fixture()
  const stale = clock() - PUSH_LIMITS.notificationTtlSeconds * 1000 - 1
  const insert = `INSERT INTO push_delivery_batches(batch_id, host_fingerprint, registration_id, kind, payload_json, state, due_at, expires_at, lease_until, attempts, created_at)
    VALUES (?, 'host', ?, 'alert', ?, 'pending', ?, ?, 0, 0, ?)`
  // One unpruned backlog row, and one whose expires_at alone would admit it.
  await db.query(insert, ['backlog', 'phone-a', JSON.stringify(notification(1)), stale, stale, stale])
  await db.query(insert, ['past-ttl', 'phone-b', JSON.stringify(notification(2)), stale, clock() + 60_000, stale])
  await store.accept('host', 'phone-c', notification(3))
  const scanned: unknown[] = []
  const capture: PushDatabase = {
    dialect: db.dialect,
    query: (sql, params) => db.query(sql, params),
    close: () => db.close(),
    lockQuotaScope: (key) => db.lockQuotaScope(key),
    tryLockScope: (key) => db.tryLockScope(key),
    tryLockSharedScope: (key) => db.tryLockSharedScope(key),
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          ...tx,
          dialect: tx.dialect,
          close: () => tx.close(),
          transaction: (inner) => tx.transaction(inner),
          lockQuotaScope: (key) => tx.lockQuotaScope(key),
          tryLockScope: (key) => tx.tryLockScope(key),
          tryLockSharedScope: (key) => tx.tryLockSharedScope(key),
          query: async (sql, params) => {
            const rows = await tx.query(sql, params)
            if (sql.startsWith(CANDIDATE_SQL)) scanned.push(...rows.map((row) => row.batch_id))
            return rows
          }
        })
      )
  }
  expect((await new DurablePushStore(capture, clock).claim())?.registrationId).toBe('phone-c')
  expect(scanned).toHaveLength(1)
  expect(scanned).not.toContain('past-ttl')
})

it('keeps claim, exclusion and prune correct without the queue index', async () => {
  const { db, store, clock, advance } = await fixture()
  await db.query('DROP INDEX push_batches_pending_device')
  await store.accept('host', 'phone', notification(1))
  advance(1)
  await store.accept('host', 'phone', notification(2))
  await store.accept('host', 'phone-2', notification(3))
  const claims = await Promise.all(
    Array.from({ length: 4 }, () => new DurablePushStore(db, clock).claim())
  )
  const leased = claims.filter((claim) => claim !== null)
  expect(leased.map((claim) => claim.notification.notificationSeq).sort()).toEqual([1, 3])
  for (const claim of leased) await store.finish(claim)
  expect((await store.claim())?.notification.notificationSeq).toBe(2)
  advance(10 * 60_000)
  expect(await store.prune()).toBe(1)
  expect(await batchCount(db)).toBe(0)
})

it('deletes a batch once it is finished, and keeps it only for a retry', async () => {
  const { db, store, advance } = await fixture()
  await store.accept('host', 'phone', notification(1))
  advance(1)
  await store.accept('host', 'phone-2', notification(2))
  const retried = (await store.claim())!
  await store.finish(retried, 1000)
  expect(await store.pendingCount(retried.registrationId)).toBe(1)
  const sent = (await store.claim())!
  await store.finish(sent)
  expect(await batchCount(db)).toBe(1)
  advance(1000)
  const retry = (await store.claim())!
  expect(retry.id).toBe(retried.id)
  await store.finish(retry, 10 * 60_000)
  expect(await batchCount(db)).toBe(0)
})

it('frees a device held by a crashed worker once its lease lapses', async () => {
  const { db, store, clock, advance } = await fixture()
  await store.accept('host', 'phone', notification(1))
  advance(1)
  await store.accept('host', 'phone', notification(2))
  const crashed = (await new DurablePushStore(db, clock).claim())!
  advance(DELIVERY_LEASE_MS - 1)
  expect(await store.claim()).toBeNull()
  advance(1)
  const reclaimed = (await store.claim())!
  expect(reclaimed.id).toBe(crashed.id)
  expect(reclaimed.attempts).toBe(2)
  await store.finish(reclaimed)
  expect((await store.claim())?.notification.notificationSeq).toBe(2)
})

it('prunes a large backlog in bounded calls without touching live or leased work', async () => {
  const { db, store, clock, advance } = await fixture()
  const perCall = PRUNE_BATCH_ROWS * PRUNE_MAX_BATCHES
  const now = clock()
  await db.query(
    `INSERT INTO push_delivery_batches(batch_id, host_fingerprint, registration_id, kind, payload_json, state, due_at, expires_at, lease_until, attempts, created_at)
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
    SELECT 'old-' || n, 'host', 'phone-' || (n % 50), 'alert', '{}', 'done', ?, ?, 0, 1, ? FROM seq`,
    [perCall + 500, now - 1, now - 1, now - 1]
  )
  await db.query(
    `INSERT INTO push_delivery_batches(batch_id, host_fingerprint, registration_id, kind, payload_json, state, due_at, expires_at, lease_until, attempts, created_at)
    VALUES ('leased', 'host', 'phone-x', 'alert', ?, 'pending', ?, ?, ?, 1, ?)`,
    [JSON.stringify(notification(9)), now - 1, now - 1, now + 1000, now - 1]
  )
  await store.accept('host', 'phone-live', notification(1))
  expect(await store.prune()).toBe(perCall)
  expect(await store.prune()).toBe(500)
  expect(await store.prune()).toBe(0)
  advance(1000)
  expect(await store.prune()).toBe(1)
  expect(await batchCount(db)).toBe(1)
  expect(await store.pendingCount('phone-live')).toBe(1)
})
