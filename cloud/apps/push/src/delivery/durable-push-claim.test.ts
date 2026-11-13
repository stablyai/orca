import { afterEach, expect, it } from 'vitest'
import type { CloudDatabase as PushDatabase } from '@orca-cloud/cloud-database/cloud-database'
import { DurablePushStore } from './durable-push-store.js'

import {
  cleanupDurablePushFixtures,
  DEVICE_HEAD_SQL,
  durablePushTestDatabaseUrl,
  fixture,
  notification,
  pauseAfter,
  within
} from './durable-push-store.test-fixture.js'

afterEach(cleanupDurablePushFixtures)

it.skipIf(!durablePushTestDatabaseUrl)(
  'rolls back a failed claim and admits a fourth waiter while the other claims stay held',
  async () => {
    const { db, store, clock, advance } = await fixture({ poolMax: 6 })
    await store.accept('host', 'phone-a', notification(1))
    advance(1)
    await store.accept('host', 'phone-b', notification(2))
    advance(1)
    await store.accept('host', 'phone-c', notification(3))
    const held = [pauseAfter(db), pauseAfter(db), pauseAfter(db)] as const
    let admitted = 0
    const failing: PushDatabase = {
      ...held[0].wrapped,
      transaction: (run) => {
        const position = admitted++
        return (held[position]?.wrapped ?? db).transaction(async (tx) => {
          const result = await run(tx)
          if (position === 0) throw new Error('claim_commit_failed')
          return result
        })
      }
    }
    const limited = new DurablePushStore(db, clock, failing)
    const first = limited.claim()
    const rejected = expect(first).rejects.toThrow('claim_commit_failed')
    await held[0].atCandidate
    const second = limited.claim()
    await held[1].atCandidate
    const third = limited.claim()
    await held[2].atCandidate
    const next = limited.claim()
    try {
      held[0].release()
      await rejected
      const delivery = await within(next, 2_000)
      expect(delivery?.notification.notificationSeq).toBe(1)
      expect(delivery?.attempts).toBe(1)
      if (!delivery) throw new Error('queued_claim_missing')
      await limited.finish(delivery)
      expect(await limited.pendingCount('phone-a')).toBe(0)
    } finally {
      for (const pause of held) pause.release()
      await Promise.allSettled([first, second, third, next])
    }
    expect((await second)?.registrationId).toBe('phone-b')
    expect((await third)?.registrationId).toBe('phone-c')
  }
)

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


