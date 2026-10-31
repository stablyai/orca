import { PRUNE_BATCH_ROWS, PRUNE_MAX_BATCHES } from './durable-push-store.js'
import { afterEach, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import {
  cleanupDurablePushFixtures,
  durablePushTestDatabaseUrl,
  within
} from './durable-push-store.test-fixture.js'
import { authorityFixture, required, TOKEN } from './push-occurrence-authority.test-fixture.js'
import { record, ownerCleanup } from './push-owner-integration.test-fixture.js'

afterEach(cleanupDurablePushFixtures)

it('bounds actual covered handoff SQL/rows/locks at N10/100 while a provider is held', async () => {
  const samples: { count: number; queries: number; rows: number }[] = []
  for (const count of [10, 100]) {
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const f = await authorityFixture({
      provider: async () => {
        entered.resolve()
        await held.promise
        return { status: 200, body: '' }
      }
    })
    let running: Promise<void> | undefined
    let primary: { failed: true; error: unknown } | undefined
    try {
      for (let seq = 1; seq <= count; seq++) {
        await f.send(f.a, f.alert(seq))
      }
      running = f.server.worker.runDue()
      await within(entered.promise, 5000)
      expect(f.requests).toHaveLength(1)
      expect(await f.rows('push_batch_admissions')).toHaveLength(1)
      f.work.length = 0
      f.locks.length = 0
      await f.send(f.a, f.read(count + 1))
      const work = [...f.work]
      const writes = work.filter((row) => row.sql.startsWith('INSERT INTO push_occurrence_domains'))
      const history = work.filter((row) => row.sql.includes('JOIN push_delivery_batches b'))
      expect(writes).toHaveLength(count)
      expect(f.locks.filter((key) => key.startsWith('push-claim:'))).toHaveLength(count)
      expect(work.filter((row) => row.sql.startsWith('SELECT * FROM push_devices'))).toHaveLength(1)
      expect(work.filter((row) => row.sql.startsWith('SELECT version, hosts_json'))).toHaveLength(1)
      expect(history).toHaveLength(Math.ceil(count / 100))
      expect(history.reduce((sum, row) => sum + row.rows, 0)).toBe(1)
      expect(work.filter((row) => row.sql.startsWith('INSERT INTO push_batch_admissions'))).toEqual(
        []
      )
      expect(
        (await f.rows('push_occurrence_domains')).every((row) => row.state === 'dismissed')
      ).toBe(true)
      expect(await f.rows('push_delivery_batches')).toHaveLength(2) // issued head and its local retraction
      samples.push({
        count,
        queries: work.length,
        rows: work.reduce((sum, row) => sum + row.rows, 0)
      })
      held.resolve()
      await running
      await f.settle()
      expect(f.requests).toHaveLength(2)
      expect(record(record(JSON.parse(required(f.requests[1]).body)).orca).kind).toBe('dismiss')
      expect(await f.rows('push_delivery_batches')).toEqual([])
      expect(await f.rows('push_batch_admissions')).toEqual([])
    } catch (error) {
      primary = { failed: true, error }
    }
    const cleanup = ownerCleanup(primary)
    await cleanup.run(() => held.resolve())
    await cleanup.run(() => running)
    await cleanup.run(() => f.close())
    cleanup.finish()
  }
  expect(required(samples[1]).queries).toBeLessThanOrEqual(required(samples[0]).queries * 10)
  expect(required(samples[1]).rows).toBeLessThanOrEqual(required(samples[0]).rows * 10)
})

it('bounds real admitted key churn by distinct live batch/domain facts and fenced finish', async () => {
  const samples: number[] = []
  for (const count of [10, 100]) {
    const f = await authorityFixture()
    let primary: { failed: true; error: unknown } | undefined
    try {
      await f.send(f.a, f.alert())
      const queued = required(await f.server.deliveryStore.claim())
      for (let index = 0; index < count; index++) {
        const key = nacl.sign.keyPair()
        await f.register(f.a.session, TOKEN, Buffer.from(key.publicKey).toString('base64url'))
        await f.declare([f.a.host], 1, key)
        const admission = f.server.deliveryStore.admission(queued)
        expect(await admission.acquire(await f.device(f.a.registrationId))).toBe('admitted')
        await admission.renew()
        await admission.renew()
        expect(await admission.acquire(await f.device(f.a.registrationId))).toBe('admitted')
        expect(await f.rows('push_batch_admissions')).toHaveLength(index + 1)
        await admission.finalize(false)
      }
      const proof = await f.rows('push_batch_admissions')
      expect(new Set(proof.map((row) => row.route_key)).size).toBe(count)
      expect(
        proof.every(
          (row) => row.batch_id === queued.id && Number(row.expires_at) === queued.expiresAt
        )
      ).toBe(true)
      await f.server.deliveryStore.finish({ ...queued, lease: 'not-the-owner' })
      expect(await f.rows('push_batch_admissions')).toEqual(proof)
      f.work.length = 0
      f.locks.length = 0
      await f.send(f.a, f.read())
      expect(
        f.work
          .filter((row) => row.sql.includes('JOIN push_delivery_batches b'))
          .reduce((sum, row) => sum + row.rows, 0)
      ).toBe(count)
      expect(
        f.work.filter((row) => row.sql.startsWith('INSERT INTO push_occurrence_domains'))
      ).toHaveLength(count)
      expect(f.locks.filter((key) => key.startsWith('push-claim:'))).toHaveLength(count)
      expect(
        f.work.filter((row) => row.sql.startsWith('INSERT INTO push_batch_admissions'))
      ).toEqual([])
      expect(f.work.filter((row) => row.sql.startsWith('SELECT version, hosts_json'))).toEqual([
        expect.objectContaining({ rows: 1 })
      ])
      samples.push(f.work.length)
      await f.server.deliveryStore.finish(queued)
      expect(await f.rows('push_batch_admissions')).toEqual([])
      await f.settle()
      expect(await f.rows('push_delivery_batches')).toEqual([])
    } catch (error) {
      primary = { failed: true, error }
    }
    const cleanup = ownerCleanup(primary)
    await cleanup.run(() => f.close())
    cleanup.finish()
  }
  expect(required(samples[1])).toBeLessThanOrEqual(required(samples[0]) * 10)
})

it('continues saturated indexed orphan cleanup without pruning a real live admission', async () => {
  const f = await authorityFixture()
  let primary: { failed: true; error: unknown } | undefined
  try {
    await f.send(f.a, f.alert())
    const queued = required(await f.server.deliveryStore.claim())
    const admission = f.server.deliveryStore.admission(queued)
    expect(await admission.acquire(await f.device(f.a.registrationId))).toBe('admitted')
    await f.database.query('UPDATE push_occurrence_domains SET created_at = ?', [
      f.clock() - 24 * 60 * 60_000 - 1
    ])
    const total = PRUNE_BATCH_ROWS * PRUNE_MAX_BATCHES + 3
    await f.database.query(
      `INSERT INTO push_batch_admissions(batch_id, destination, route_key, attempt, expires_at)
      WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
      SELECT 'orphan-' || n, 'destination', 'key', 'attempt', ? FROM seq`,
      [total, f.clock() - 1]
    )
    f.work.length = 0
    expect(await f.server.deliveryStore.prune()).toEqual({ deleted: total - 3, saturated: true })
    const first = f.work.filter((row) => row.sql.startsWith('DELETE FROM push_batch_admissions'))
    expect(first).toHaveLength(PRUNE_MAX_BATCHES)
    expect(
      first.every(
        (row) =>
          row.sql.includes('expires_at <= ? AND NOT EXISTS') &&
          row.sql.includes(`LIMIT ${PRUNE_BATCH_ROWS}`)
      )
    ).toBe(true)
    expect(await f.rows('push_batch_admissions')).toHaveLength(4)
    expect(await f.rows('push_occurrence_domains')).toHaveLength(1)
    expect(await f.server.deliveryStore.prune()).toEqual({ deleted: 3, saturated: false })
    expect(await f.rows('push_batch_admissions')).toHaveLength(1)
    await admission.finalize(true)
    await f.server.deliveryStore.finish(queued)
    expect(await f.rows('push_batch_admissions')).toEqual([])
  } catch (error) {
    primary = { failed: true, error }
  }
  const cleanup = ownerCleanup(primary)
  await cleanup.run(() => f.close())
  cleanup.finish()
})

it.skipIf(!durablePushTestDatabaseUrl)(
  'skips a held PG orphan while removing another and reclaims it after release',
  async () => {
    const f = await authorityFixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let holding: Promise<void> | undefined
    let primary: { failed: true; error: unknown } | undefined
    try {
      await f.database.query(
        `INSERT INTO push_batch_admissions(batch_id, destination, route_key, attempt, expires_at)
      VALUES ('held-orphan', 'destination', 'key', 'attempt', ?), ('free-orphan', 'destination', 'key', 'attempt', ?)`,
        [f.clock() - 2, f.clock() - 1]
      )
      holding = f.database.transaction(async (tx) => {
        await tx.query(
          "SELECT * FROM push_batch_admissions WHERE batch_id = 'held-orphan' FOR UPDATE"
        )
        entered.resolve()
        await release.promise
      })
      await within(entered.promise, 5000)
      expect(await within(f.server.deliveryStore.prune(), 1000)).toEqual({
        deleted: 1,
        saturated: false
      })
      expect((await f.rows('push_batch_admissions')).map((row) => row.batch_id)).toEqual([
        'held-orphan'
      ])
      release.resolve()
      await holding
      expect(await f.server.deliveryStore.prune()).toEqual({ deleted: 1, saturated: false })
      expect(await f.rows('push_batch_admissions')).toEqual([])
    } catch (error) {
      primary = { failed: true, error }
    }
    const cleanup = ownerCleanup(primary)
    await cleanup.run(() => release.resolve())
    await cleanup.run(() => holding)
    await cleanup.run(() => f.close())
    cleanup.finish()
  }
)
