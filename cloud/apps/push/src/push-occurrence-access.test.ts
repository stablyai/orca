import { afterEach, expect, it } from 'vitest'
import {
  cleanupDurablePushFixtures,
  pauseAfter,
  within
} from './durable-push-store.test-fixture.js'
import { required } from './push-occurrence-authority.test-fixture.js'
import {
  accessFixture,
  assertAccess,
  clearCorpus,
  irrelevantCorpus
} from './push-occurrence-access.test-fixture.js'
import { ownerCleanup, record } from './push-owner-integration.test-fixture.js'

afterEach(cleanupDurablePushFixtures)

it('isolates captured covered-PK history on natural real-engine plans and releases its actual owner', async () => {
  let gate: ReturnType<typeof pauseAfter> | undefined
  let failReadOnce = true
  const owner = await accessFixture({
    database: (db) => {
      const paused = pauseAfter(db, 'SELECT a.batch_id')
      gate = paused
      return {
        ...paused.wrapped,
        transaction: (run) =>
          paused.wrapped.transaction((tx) =>
            run({
              ...tx,
              query: async (sql, params) => {
                const rows = await tx.query(sql, params)
                if (
                  db.dialect === 'postgres' &&
                  failReadOnce &&
                  sql.startsWith('SELECT a.batch_id')
                ) {
                  failReadOnce = false
                  // Real engine fault on the owned transaction; retry must reconstruct the whole read.
                  await tx.query(
                    "DO $$ BEGIN RAISE EXCEPTION 'owned read retry' USING ERRCODE = '40001'; END $$"
                  )
                }
                return rows
              }
            })
          )
      }
    }
  })
  const { f } = owner
  let read: Promise<void> | undefined
  let primary: { failed: true; error: unknown } | undefined
  try {
    await f.send(f.a, f.alert())
    const queued = required(await f.server.deliveryStore.claim())
    const admission = f.server.deliveryStore.admission(queued)
    expect(await admission.acquire(await f.device(f.a.registrationId))).toBe('admitted')
    await admission.finalize(false)
    expect(await f.rows('push_batch_admissions')).toHaveLength(1)
    f.work.length = 0
    read = f.send(f.a, f.read())
    await within(
      Promise.race([
        required(gate).atCandidate,
        read.then(() => {
          throw new Error('Read completed before its captured history boundary')
        })
      ]),
      5000
    )
    if (f.database.dialect === 'postgres') {
      expect(await within(admission.acquire(await f.device(f.a.registrationId)), 1000)).toBe(
        'deferred'
      )
      expect(await f.rows('push_batch_admissions')).toHaveLength(1)
    }
    expect(f.requests).toEqual([])
    required(gate).release()
    await read
    const history = required(
      f.work.find(
        (entry) => entry.sql.startsWith('SELECT a.batch_id') && entry.outcome === 'returned'
      )
    )
    if (f.database.dialect === 'postgres') {
      const failed = f.work.filter((entry) => entry.outcome === 'error')
      expect(failed).toHaveLength(1)
      expect(record(required(failed[0]).error).code).toBe('40001')
      expect(f.activity.transactions.filter((entry) => entry.attempts === 2)).toEqual([
        { attempts: 2, errors: [required(failed[0]).error], outcome: 'committed' }
      ])
    }
    expect(history.rows).toBe(1)
    expect(history.params).toEqual([queued.id, f.a.host, f.a.registrationId, f.clock()])
    expect(history.returnedBytes).toBeGreaterThan(100)
    expect((await f.rows('push_occurrence_domains')).map((row) => row.state)).toEqual(['dismissed'])
    for (const axis of ['history', 'queue', 'domains'] as const) {
      for (const count of [1000, 10_000]) {
        for (const population of ['history', 'queue', 'domains'] as const) {
          await irrelevantCorpus(f, population, population === axis ? count : 1000)
        }
        const proofRows = () =>
          f.database.query(
            'SELECT * FROM push_batch_admissions ORDER BY batch_id, destination, route_key'
          )
        const before = await proofRows()
        const plan = await owner.explain(history)
        assertAccess(
          plan,
          f.database.dialect === 'postgres'
            ? ['push_batch_admissions_pkey', 'push_delivery_batches_pkey']
            : [
                'sqlite_autoindex_push_batch_admissions_1',
                'sqlite_autoindex_push_delivery_batches_1'
              ],
          f.database.dialect,
          `covered:${axis}:${count}`
        )
        expect(await proofRows()).toEqual(before)
        await clearCorpus(f)
      }
    }
    await f.server.deliveryStore.finish({ ...queued, lease: 'stale' })
    expect(await f.rows('push_batch_admissions')).toHaveLength(1)
    await f.server.deliveryStore.finish(queued)
    await f.send(f.b, f.alert())
    await f.settle()
    expect(f.requests.map((request) => record(record(JSON.parse(request.body)).orca))).toEqual([
      expect.objectContaining({ kind: 'dismiss', hostFingerprint: f.a.host, notificationSeq: 2 })
    ])
    expect(await f.rows('push_delivery_batches')).toEqual([])
    expect(await f.rows('push_batch_admissions')).toEqual([])
  } catch (error) {
    primary = { failed: true, error }
  }
  const cleanup = ownerCleanup(primary)
  await cleanup.run(() => gate?.release())
  await cleanup.run(() => read)
  await cleanup.run(() => owner.close())
  cleanup.finish()
})

it('bounds natural retention/expiry join candidates, skips held rows and preserves a leased expired parent', async () => {
  const owner = await accessFixture()
  const { f } = owner
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let holding: Promise<void> | undefined
  let primary: { failed: true; error: unknown } | undefined
  try {
    await f.send(f.a, f.alert())
    const queued = required(await f.server.deliveryStore.claim())
    const admission = f.server.deliveryStore.admission(queued)
    expect(await admission.acquire(await f.device(f.a.registrationId))).toBe('admitted')
    await admission.finalize(true)
    await f.database.query('UPDATE push_occurrence_domains SET created_at = ?', [
      f.clock() - 86_400_001
    ])
    f.work.length = 0
    expect(await f.server.deliveryStore.prune()).toEqual({ deleted: 0, saturated: false })
    const retention = required(
      f.work.find((entry) => entry.sql.startsWith('DELETE FROM push_occurrence_domains'))
    )
    const expiry = required(
      f.work.find((entry) => entry.sql.startsWith('DELETE FROM push_batch_admissions'))
    )
    const seedCandidates = async () => {
      await f.database.query(
        `INSERT INTO push_occurrence_domains
        (destination, route_key, origin, occurrence, state, lease_until, created_at)
        VALUES ('free-q', 'key', 'origin', 'occurrence', 'sent', 0, ?),
        ('held-q', 'key', 'origin', 'occurrence', 'sent', 0, ?)`,
        [f.clock() - 86_400_002, f.clock() - 86_400_001]
      )
      await f.database.query(
        `INSERT INTO push_batch_admissions VALUES
        ('free-orphan', 'destination', 'key', 'attempt', ?),
        ('held-orphan', 'destination', 'key', 'attempt', ?)`,
        [f.clock() - 2, f.clock() - 1]
      )
    }
    for (const axis of ['history', 'queue', 'domains'] as const) {
      for (const count of [1000, 10_000]) {
        await seedCandidates()
        for (const population of ['history', 'queue', 'domains'] as const) {
          await irrelevantCorpus(f, population, population === axis ? count : 1000)
        }
        const contents = () =>
          Promise.all([
            f.database.query(
              'SELECT * FROM push_batch_admissions ORDER BY batch_id, destination, route_key'
            ),
            f.database.query(
              'SELECT * FROM push_occurrence_domains ORDER BY destination, route_key, origin, occurrence'
            )
          ])
        const before = await contents()
        for (const [work, table, index] of [
          [retention, 'push_occurrence_domains', 'push_domains_retention'],
          [expiry, 'push_batch_admissions', 'push_admissions_expiry']
        ] as const) {
          const plan = await owner.explain(work, table)
          const proofPk =
            f.database.dialect === 'postgres'
              ? 'push_batch_admissions_pkey'
              : 'sqlite_autoindex_push_batch_admissions_1'
          assertAccess(
            plan,
            [
              index,
              ...(table === 'push_occurrence_domains' ? [proofPk] : []),
              f.database.dialect === 'postgres'
                ? 'push_delivery_batches_pkey'
                : 'sqlite_autoindex_push_delivery_batches_1'
            ],
            f.database.dialect,
            `${table}:${axis}:${count}`
          )
          if (f.database.dialect === 'postgres') {
            expect(plan.changed).toBe(2)
          }
        }
        expect(await contents()).toEqual(before) // EXPLAIN ANALYZE mutations rolled back on the owned diagnostic connection.
        f.work.length = 0
        f.activity.transactions.length = 0
        f.activity.advisory.length = 0
        expect(await f.server.deliveryStore.prune()).toEqual({ deleted: 4, saturated: false })
        expect(f.work).toHaveLength(7)
        expect(f.work.every((entry) => entry.outcome === 'returned')).toBe(true)
        expect(f.work.reduce((sum, entry) => sum + entry.changes, 0)).toBe(4)
        expect(f.activity.transactions).toEqual([]) // Autocommit method calls, not observed BEGIN/COMMIT counts.
        expect(f.activity.advisory).toEqual([]) // SKIP LOCKED row operations are inside the engine.
        expect(await f.rows('push_batch_admissions')).toHaveLength(
          (axis === 'history' ? count : 1000) + 1
        )
        expect(await f.rows('push_occurrence_domains')).toHaveLength(
          (axis === 'domains' ? count : 1000) + 1
        )
        await clearCorpus(f)
      }
    }
    await seedCandidates()
    if (f.database.dialect === 'postgres') {
      holding = f.database.transaction(async (tx) => {
        await tx.query(
          "SELECT * FROM push_occurrence_domains WHERE destination = 'held-q' FOR UPDATE"
        )
        await tx.query(
          "SELECT * FROM push_batch_admissions WHERE batch_id = 'held-orphan' FOR UPDATE"
        )
        entered.resolve()
        await release.promise
      })
      await within(
        Promise.race([
          entered.promise,
          holding.then(() => {
            throw new Error('Owner released before the held candidate boundary')
          })
        ]),
        5000
      )
      for (const [work, table] of [
        [retention, 'push_occurrence_domains'],
        [expiry, 'push_batch_admissions']
      ] as const) {
        const plan = await owner.explain(work, table)
        expect(plan.changed).toBe(1)
        expect(plan.visits).toBeLessThanOrEqual(128)
      }
    }
    expect(await within(f.server.deliveryStore.prune(), 1000)).toEqual({
      deleted: f.database.dialect === 'postgres' ? 2 : 4,
      saturated: false
    })
    release.resolve()
    await holding
    expect(await f.server.deliveryStore.prune()).toEqual({
      deleted: f.database.dialect === 'postgres' ? 2 : 0,
      saturated: false
    })
    expect(await f.rows('push_occurrence_domains')).toHaveLength(1)
    expect(await f.rows('push_batch_admissions')).toHaveLength(1)
    f.advance(299_000)
    await f.server.deliveryStore.renew(queued)
    f.advance(1001)
    expect(await f.server.deliveryStore.prune()).toEqual({ deleted: 1, saturated: false })
    const parent = required((await f.rows('push_delivery_batches'))[0])
    expect(Number(parent.expires_at)).toBe(queued.expiresAt)
    expect(Number(parent.expires_at)).toBeLessThan(f.clock())
    expect(Number(parent.lease_until)).toBeGreaterThan(f.clock())
    expect(await f.rows('push_batch_admissions')).toHaveLength(1)
    f.advance(30_001)
    expect(await f.server.deliveryStore.prune()).toEqual({ deleted: 2, saturated: false })
    expect(await f.rows('push_delivery_batches')).toEqual([])
    expect(await f.rows('push_batch_admissions')).toEqual([])
    expect(await f.rows('push_occurrence_domains')).toEqual([])
    expect(f.requests).toEqual([])
  } catch (error) {
    primary = { failed: true, error }
  }
  const cleanup = ownerCleanup(primary)
  await cleanup.run(() => release.resolve())
  await cleanup.run(() => holding)
  await cleanup.run(() => owner.close())
  cleanup.finish()
})
