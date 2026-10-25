import { afterEach, expect, it, vi } from 'vitest'
import { DurablePushStore } from './durable-push-store.js'
import type { PushDatabase } from './push-database.js'
import {
  cleanupDurablePushFixtures,
  fixture,
  notification
} from './durable-push-store.test-fixture.js'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupDurablePushFixtures()
})

function captureDatabaseErrors(database: PushDatabase, errors: unknown[]): PushDatabase {
  return {
    dialect: database.dialect,
    query: async (sql, params) => {
      try {
        return await database.query(sql, params)
      } catch (error) {
        errors.push(error)
        throw error
      }
    },
    transaction: (run) => database.transaction((tx) => run(captureDatabaseErrors(tx, errors))),
    lockQuotaScope: (key) => database.lockQuotaScope(key),
    tryLockScope: (key) => database.tryLockScope(key),
    tryLockSharedScope: (key) => database.tryLockSharedScope(key),
    close: () => database.close()
  }
}

it('parses each leased row once and preserves its complete serialized payload', async () => {
  const { db, store } = await fixture()
  const input = {
    ...notification(1),
    body: 'Unicode: 🐋\ud800',
    extra: { first: [null, false, 3], next: { z: 'last', a: 'first' } }
  }
  await store.accept('host', 'phone', input)
  const [row] = await db.query('SELECT * FROM push_delivery_batches')
  if (!row) {
    throw new Error('Missing delivery row')
  }
  const payload = String(row.payload_json)
  const parse = vi.spyOn(JSON, 'parse')
  const delivery = await store.claim()
  expect(delivery).toEqual({
    id: row.batch_id,
    registrationId: 'phone',
    hostFingerprint: 'host',
    notification: input,
    expiresAt: 1_300_000,
    lease: expect.any(String),
    attempts: 1
  })
  expect(JSON.stringify(delivery?.notification)).toBe(payload)
  expect(parse.mock.calls.filter(([value]) => value === payload)).toHaveLength(1)
})

it('keeps concurrent device claims separate and returns fresh payload objects', async () => {
  const { store } = await fixture()
  const input = notification(1)
  await store.accept('host', 'phone-a', input)
  await store.accept('host', 'phone-b', input)
  const payload = JSON.stringify(input)
  const parse = vi.spyOn(JSON, 'parse')
  const claims = await Promise.all(Array.from({ length: 4 }, () => store.claim()))
  const delivered = claims.filter((claim) => claim !== null)
  expect(delivered).toHaveLength(2)
  expect(delivered.map((claim) => claim.registrationId).sort()).toEqual(['phone-a', 'phone-b'])
  expect(delivered.every((claim) => JSON.stringify(claim.notification) === payload)).toBe(true)
  expect(delivered[0]?.notification).not.toBe(delivered[1]?.notification)
  expect(parse.mock.calls.filter(([value]) => value === payload)).toHaveLength(2)
})

it('reads changed retry bytes and a later writer update without carrying a parsed result across calls', async () => {
  const { db, store, advance } = await fixture()
  await store.accept('host', 'phone', notification(1))
  const first = await store.claim()
  if (!first) {
    throw new Error('Missing first delivery')
  }
  first.notification.body = 'provider changed this retry'
  await store.finish(first, 1000)
  advance(1000)
  const retriedPayload = JSON.stringify(first.notification)
  const parse = vi.spyOn(JSON, 'parse')
  const retry = await store.claim()
  expect(retry).toEqual({ ...first, lease: expect.any(String), attempts: 2 })
  expect(retry?.lease).not.toBe(first.lease)
  expect(retry?.notification).not.toBe(first.notification)
  expect(JSON.stringify(retry?.notification)).toBe(retriedPayload)
  const retryParses = parse.mock.calls.filter(([value]) => value === retriedPayload).length
  if (!retry) {
    throw new Error('Missing retry delivery')
  }
  await store.finish(retry, 1000)
  const changed = { ...notification(1), body: 'fresh database row', title: 'Changed' }
  const changedPayload = JSON.stringify(changed)
  await db.query('UPDATE push_delivery_batches SET payload_json = ? WHERE batch_id = ?', [
    changedPayload,
    first.id
  ])
  advance(1000)
  const fresh = await store.claim()
  expect(fresh).toEqual({ ...retry, notification: changed, lease: expect.any(String), attempts: 3 })
  expect(JSON.stringify(fresh?.notification)).toBe(changedPayload)
  expect(retry.notification.body).toBe('provider changed this retry')
  expect(retryParses).toBe(1)
  expect(parse.mock.calls.filter(([value]) => value === changedPayload)).toHaveLength(1)
})

it('parses dismissed alerts once and removes them without returning a delivery', async () => {
  const { db, store, clock } = await fixture()
  const input = notification(1)
  await store.accept('host', 'phone', input)
  await db.query(
    'INSERT INTO push_dismissed_events(host_fingerprint, notification_epoch, notification_id, notification_seq, created_at) VALUES (?, ?, ?, ?, ?)',
    ['host', 'epoch', input.notificationId, 1, clock()]
  )
  const parse = vi.spyOn(JSON, 'parse')
  expect(await store.claim()).toBeNull()
  expect(await store.pendingCount('phone')).toBe(0)
  expect(parse.mock.calls.filter(([value]) => value === JSON.stringify(input))).toHaveLength(1)
})

it('preserves the existing trust boundary for an object missing notification fields', async () => {
  const { db, store } = await fixture()
  await store.accept('host', 'phone', notification(1))
  await db.query('UPDATE push_delivery_batches SET payload_json = ?', ['{}'])
  const parse = vi.spyOn(JSON, 'parse')
  const delivery = await store.claim()
  expect(delivery?.notification).toEqual({})
  expect(JSON.stringify(delivery?.notification)).toBe('{}')
  expect(parse.mock.calls.filter(([value]) => value === '{}')).toHaveLength(1)
})

it.each(['not JSON', 'undefined', 'null', '[]'])(
  'preserves invalid payload rejection and rolls back the lease for %s',
  async (payload) => {
    const { db, store } = await fixture()
    await store.accept('host', 'phone', notification(1))
    await db.query('UPDATE push_delivery_batches SET payload_json = ?', [payload])
    const [before] = await db.query('SELECT * FROM push_delivery_batches')
    const parse = vi.spyOn(JSON, 'parse')
    let caught: unknown
    try {
      await store.claim()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const index = parse.mock.calls.findIndex(([value]) => value === payload)
    expect(index).toBeGreaterThanOrEqual(0)
    if (payload === 'not JSON' || payload === 'undefined') {
      expect(caught).toBe(parse.mock.results[index]?.value)
      expect(caught).toBeInstanceOf(SyntaxError)
    } else {
      expect(caught).toMatchObject({ message: 'invalid_push_delivery_payload' })
    }
    expect(await db.query('SELECT * FROM push_delivery_batches')).toEqual([before])
    expect(parse.mock.calls.filter(([value]) => value === payload)).toHaveLength(1)
  }
)

it('preserves the exact database UPDATE error and retries with a fresh payload after rollback', async () => {
  const { db, store, clock } = await fixture()
  await store.accept('host', 'phone', notification(1))
  const [before] = await db.query('SELECT * FROM push_delivery_batches')
  if (!before) {
    throw new Error('Missing delivery row')
  }
  const originalQuery = db.query.bind(db)
  const errors: unknown[] = []
  // SQLite raises a native error in the real transaction; PostgreSQL uses its real constraint.
  await originalQuery(
    db.dialect === 'sqlite'
      ? "CREATE TRIGGER deny_lease BEFORE UPDATE ON push_delivery_batches BEGIN SELECT RAISE(FAIL, 'deny_lease'); END"
      : 'ALTER TABLE push_delivery_batches ADD CONSTRAINT deny_lease CHECK (lease_until = 0)'
  )
  const owner = new DurablePushStore(captureDatabaseErrors(db, errors), clock)
  const parse = vi.spyOn(JSON, 'parse')
  let caught: unknown
  try {
    await owner.claim()
  } catch (error) {
    caught = error
  }
  expect(errors).toHaveLength(1)
  expect(caught).toBe(errors[0])
  expect(await originalQuery('SELECT * FROM push_delivery_batches')).toEqual([before])
  expect(parse.mock.calls.filter(([value]) => value === String(before.payload_json))).toHaveLength(
    1
  )
  await originalQuery(
    db.dialect === 'sqlite'
      ? 'DROP TRIGGER deny_lease'
      : 'ALTER TABLE push_delivery_batches DROP CONSTRAINT deny_lease'
  )
  const fresh = await owner.claim()
  expect(fresh?.notification).toEqual(notification(1))
  expect(fresh?.attempts).toBe(1)
})
