import { afterEach, expect, it } from 'vitest'
import { cleanupDurablePushFixtures } from './durable-push-store.test-fixture.js'
import { authorityFixture, required } from './push-occurrence-authority.test-fixture.js'
import {
  drainPopulations,
  storedNonnegativeInteger
} from './push-occurrence-settlement.test-fixture.js'
import { pushDestination } from './push-occurrence-admission.js'
import { text, ownerCleanup, record } from './push-owner-integration.test-fixture.js'

afterEach(cleanupDurablePushFixtures)

it('reads equivalent stored queue integers without certifying malformed or unsafe values', () => {
  for (const value of [0, 1, 1001000, 1300000, Number.MAX_SAFE_INTEGER]) {
    expect(storedNonnegativeInteger(value)).toBe(value)
    expect(storedNonnegativeInteger(String(value))).toBe(value)
  }
  for (const value of [
    null,
    undefined,
    '',
    ' ',
    '0\n',
    ' 1',
    '1 ',
    '-0',
    '+0',
    '-1',
    '01',
    '1.0',
    '1e3',
    '1x',
    true,
    {},
    Number.NaN,
    Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    '9007199254740992'
  ]) {
    expect(() => storedNonnegativeInteger(value)).toThrow(
      'Expected stored nonnegative safe integer'
    )
  }
})

it.each(['noncovered', 'unrelated', 'membership'] as const)(
  'isolates actual covered authority from independent %s population N10/100',
  async (axis) => {
    const samples: number[] = []
    for (const count of [10, 100]) {
      const f = await authorityFixture()
      let primary: { failed: true; error: unknown } | undefined
      try {
        if (axis === 'membership') {
          const hosts = [
            f.a.host,
            f.b.host,
            ...Array.from({ length: count - 2 }, (_, i) => String(i).padStart(f.a.host.length, 'x'))
          ]
          await f.declare(hosts, 2)
          const [stored] = await f.database.query('SELECT hosts_json FROM push_route_declarations')
          expect(JSON.parse(String(required(stored).hosts_json))).toEqual([...hosts].sort())
          expect(new Set(hosts).size).toBe(count)
        }
        if (axis === 'noncovered') {
          for (let i = 0; i < count; i++) {
            await f.send(f.a, { ...f.alert(i + 100), notificationId: `other-${i}` })
          }
        }
        // Maintenance populations are input data, never claimed as genuine admissions.
        if (axis === 'unrelated') {
          for (let i = 0; i < count; i++) {
            const id = `unrelated-${i}`
            await f.database.query(
              `INSERT INTO push_devices(registration_id,
              host_fingerprint, device_id, platform, token, created_at, updated_at)
              VALUES (?, ?, ?, 'ios', ?, ?, ?)`,
              [id, id, id, id, f.clock(), f.clock()]
            )
            await f.database.query(
              `INSERT INTO push_route_declarations(destination,
              route_key, version, hosts_json, updated_at) VALUES (?, ?, 1, '[]', ?)`,
              [id, id, f.clock()]
            )
            await f.database.query(
              `INSERT INTO push_occurrence_domains(destination,
              route_key, origin, occurrence, state, lease_until, created_at)
              VALUES (?, ?, ?, ?, 'sent', 0, ?)`,
              [id, id, id, id, f.clock()]
            )
            await f.database.query(
              `INSERT INTO push_batch_admissions(batch_id,
              destination, route_key, attempt, expires_at) VALUES (?, ?, ?, ?, ?)`,
              [id, id, id, id, f.clock() + 300_000]
            )
          }
        }
        const unrelated = async () =>
          Promise.all([
            f.database.query(
              "SELECT * FROM push_devices WHERE registration_id LIKE 'unrelated-%' ORDER BY registration_id"
            ),
            f.database.query(
              "SELECT * FROM push_route_declarations WHERE destination LIKE 'unrelated-%' ORDER BY destination"
            ),
            f.database.query(
              "SELECT * FROM push_occurrence_domains WHERE destination LIKE 'unrelated-%' ORDER BY destination"
            ),
            f.database.query(
              "SELECT * FROM push_batch_admissions WHERE batch_id LIKE 'unrelated-%' ORDER BY batch_id"
            )
          ])
        const before = await unrelated()
        expect(before.map((rows) => rows.length)).toEqual(
          Array(4).fill(axis === 'unrelated' ? count : 0)
        )
        await f.send(f.a, f.alert())
        f.work.length = 0
        f.activity.advisory.length = 0
        f.activity.transactions.length = 0
        await f.send(f.a, f.read())
        const work = [...f.work]
        const scanned = required(
          work.find((entry) => entry.sql.startsWith('SELECT batch_id, payload_json'))
        )
        expect(scanned.rows).toBe(axis === 'noncovered' ? count + 1 : 1)
        const history = work.filter((entry) => entry.sql.includes('JOIN push_delivery_batches b'))
        expect(history).toHaveLength(1)
        expect(required(history[0]).rows).toBe(0)
        expect(required(history[0]).params.slice(1)).toEqual([
          f.a.host,
          f.a.registrationId,
          f.clock()
        ])
        expect(
          work.filter((entry) => entry.sql.startsWith('SELECT * FROM push_devices'))
        ).toHaveLength(1)
        expect(
          work.filter((entry) => entry.sql.startsWith('SELECT version, hosts_json'))
        ).toHaveLength(1)
        expect(
          work.filter((entry) => entry.sql.startsWith('INSERT INTO push_occurrence_domains'))
        ).toHaveLength(1)
        expect(work.reduce((sum, entry) => sum + entry.returning, 0)).toBe(1)
        expect(work.every((entry) => entry.outcome === 'returned')).toBe(true)
        expect(
          work.filter((entry) => entry.sql.startsWith('INSERT INTO push_batch_admissions'))
        ).toEqual([])
        expect(f.activity.transactions).toEqual([{ attempts: 1, errors: [], outcome: 'committed' }])
        expect(f.activity.advisory.every((entry) => entry.outcome === 'returned')).toBe(true)
        expect(
          f.activity.advisory.filter((entry) => entry.key.startsWith('push-claim:'))
        ).toHaveLength(1)
        samples.push(work.length)
        await f.send(f.b, f.alert())
        await drainPopulations(
          f,
          `${axis}/N${count}`,
          axis === 'noncovered' && count === 10 && f.db.dialect === 'postgres'
        )
        const bodies = f.requests.map((request) => record(record(JSON.parse(request.body)).orca))
        expect(bodies.filter((body) => body.kind === 'dismiss')).toEqual([
          expect.objectContaining({
            hostFingerprint: f.a.host,
            notificationSeq: 2,
            notificationId: 'subject'
          })
        ])
        expect(bodies.filter((body) => body.kind !== 'dismiss')).toHaveLength(
          axis === 'noncovered' ? count : 0
        )
        expect(bodies.every((body) => body.hostFingerprint === f.a.host)).toBe(true)
        expect(await f.rows('push_delivery_batches')).toEqual([])
        expect(
          (await f.rows('push_batch_admissions')).filter(
            (row) => row.batch_id !== undefined && !String(row.batch_id).startsWith('unrelated-')
          )
        ).toEqual([])
        expect(await unrelated()).toEqual(before)
      } catch (error) {
        primary = { failed: true, error }
      }
      const cleanup = ownerCleanup(primary)
      await cleanup.run(() => f.close())
      cleanup.finish()
    }
    expect(required(samples[1])).toBe(required(samples[0]))
  }
)

it.each(['history', 'domains'] as const)(
  'varies actual %s with covered C100 fixed and independently controlled P/V',
  async (axis) => {
    const samples: number[] = []
    for (const count of [10, 100]) {
      const f = await authorityFixture()
      let primary: { failed: true; error: unknown } | undefined
      try {
        const proofCount = axis === 'history' ? count : 100
        const domains = axis === 'domains' ? count : 1
        for (let i = 1; i <= 100; i++) {
          await f.send(f.a, { ...f.alert(((i - 1) % domains) + 1), notificationSeq: i })
        }
        const batches = new Set<string>()
        for (let i = 0; i < proofCount; i++) {
          const queued = required(await f.server.deliveryStore.claim())
          expect(batches.has(queued.id)).toBe(false)
          batches.add(queued.id)
          const admission = f.server.deliveryStore.admission(queued)
          expect(await admission.acquire(await f.device(f.a.registrationId))).toBe('admitted')
          await admission.renew()
          await admission.finalize(false)
          await f.server.deliveryStore.finish(queued, 1000)
        }
        const proof = await f.rows('push_batch_admissions')
        expect(proof).toHaveLength(proofCount)
        expect(await f.rows('push_delivery_batches')).toHaveLength(100)
        expect(new Set(proof.map((row) => row.route_key))).toEqual(new Set([f.routeKey]))
        expect(new Set(proof.map((row) => row.batch_id))).toEqual(batches)
        expect(f.requests).toEqual([])
        f.work.length = 0
        f.activity.transactions.length = 0
        f.activity.advisory.length = 0
        await f.send(f.a, f.read(101))
        const history = f.work.filter((entry) => entry.sql.includes('JOIN push_delivery_batches b'))
        expect(history).toHaveLength(1)
        expect(history.reduce((sum, entry) => sum + entry.rows, 0)).toBe(proofCount)
        const writes = f.work.filter((entry) =>
          entry.sql.startsWith('INSERT INTO push_occurrence_domains')
        )
        expect(writes).toHaveLength(domains)
        expect(writes.every((entry) => entry.changes === 1)).toBe(true)
        expect(f.work.reduce((sum, entry) => sum + entry.returning, 0)).toBe(100)
        expect(
          f.work
            .filter((entry) => entry.sql.startsWith('DELETE FROM push_batch_admissions'))
            .reduce((sum, entry) => sum + entry.changes, 0)
        ).toBe(proofCount)
        expect(
          f.work.filter((entry) => entry.sql.startsWith('INSERT INTO push_batch_admissions'))
        ).toEqual([])
        expect(f.activity.transactions).toEqual([{ attempts: 1, errors: [], outcome: 'committed' }])
        expect(
          f.activity.advisory.filter((entry) => entry.key.startsWith('push-claim:'))
        ).toHaveLength(domains)
        expect(history.reduce((sum, entry) => sum + entry.returnedBytes, 0)).toBeGreaterThan(
          proofCount * 100
        )
        samples.push(f.work.length)
        expect(await f.rows('push_batch_admissions')).toEqual([])
        await f.send(f.b, f.alert())
        f.advance(1000)
        await drainPopulations(f, `C100/${axis}/N${count}`)
        expect(f.requests.map((request) => record(record(JSON.parse(request.body)).orca))).toEqual([
          expect.objectContaining({
            hostFingerprint: f.a.host,
            kind: 'dismiss',
            notificationId: 'subject',
            notificationSeq: 101
          })
        ])
        expect(await f.rows('push_delivery_batches')).toEqual([])
        expect(await f.rows('push_batch_admissions')).toEqual([])
      } catch (error) {
        primary = { failed: true, error }
      }
      const cleanup = ownerCleanup(primary)
      await cleanup.run(() => f.close())
      cleanup.finish()
    }
    expect(required(samples[1])).toBeLessThanOrEqual(required(samples[0]) * 10)
  }
)

it('bounds warmed direct-store accept and causal delivery work at N and10N queued occurrences', async () => {
  const samples: { store: number; total: number }[] = []
  for (const count of [10, 100]) {
    const f = await authorityFixture()
    let primary: { failed: true; error: unknown } | undefined
    try {
      const warm = { ...f.alert(), occurrence: 'o'.repeat(43) }
      for (const actor of [f.a, f.b]) {
        expect(await f.server.deliveryStore.accept(actor.host, actor.registrationId, warm)).toBe(
          'queued'
        )
      }
      const claimed = [
        required(await f.server.deliveryStore.claim()),
        required(await f.server.deliveryStore.claim())
      ]
      expect(new Set(claimed.map((queued) => queued.registrationId))).toEqual(
        new Set([f.a.registrationId, f.b.registrationId])
      )
      for (const queued of claimed) {
        await f.server.deliveryStore.finish(queued)
      }
      expect(await f.rows('push_delivery_batches')).toEqual([])
      expect(await f.rows('push_batch_admissions')).toEqual([])
      expect(f.requests).toEqual([])
      const destination = pushDestination(await f.device(f.a.registrationId))
      const start = f.work.length
      const txStart = f.activity.transactions.length
      const alerts = Array.from({ length: count }, (_, i) => ({
        ...f.alert(i + 2),
        occurrence: String(i).padStart(43, 'o')
      }))
      for (const alert of alerts) {
        expect(await f.server.deliveryStore.accept(f.a.host, f.a.registrationId, alert)).toBe(
          'queued'
        )
      }
      const duties = await f.rows('push_delivery_batches')
      expect(duties).toHaveLength(count)
      expect(
        duties.every(
          (row) => row.host_fingerprint === f.a.host && row.registration_id === f.a.registrationId
        )
      ).toBe(true)
      expect(
        duties
          .map((row) => record(JSON.parse(text(row.payload_json))))
          .toSorted(
            (left, right) =>
              storedNonnegativeInteger(left.notificationSeq) -
              storedNonnegativeInteger(right.notificationSeq)
          )
      ).toEqual(alerts)
      await drainPopulations(f, `ordinary-direct-store/N${count}`)
      const work = f.work.slice(start)
      const dispatcherLookups = work.filter(
        (entry) =>
          entry.sql.replace(/\s+/g, ' ').trim() ===
            'SELECT registration_id, host_fingerprint, device_id, platform, token, apns_environment, dead_at, route_key FROM push_devices WHERE registration_id = ?' &&
          entry.params.length === 1 &&
          entry.params[0] === f.a.registrationId
      )
      samples.push({ store: work.length - dispatcherLookups.length, total: work.length })
      const identities = (bodies: Record<string, unknown>[]) =>
        bodies
          .map((body) =>
            JSON.stringify([
              body.notificationId,
              body.notificationEpoch,
              body.notificationSeq,
              body.origin,
              body.occurrence
            ])
          )
          .toSorted()
      const delivered = f.requests.map((request) => record(record(JSON.parse(request.body)).orca))
      expect(delivered).toHaveLength(count)
      expect(
        delivered.every((body) => body.hostFingerprint === f.a.host && body.kind === 'alert')
      ).toBe(true)
      expect(identities(delivered)).toEqual(identities(alerts))
      const admissions = work.filter((entry) =>
        entry.sql.startsWith('INSERT INTO push_batch_admissions')
      )
      expect(admissions).toHaveLength(count)
      expect(new Set(admissions.map((entry) => entry.params[0]))).toEqual(
        new Set(duties.map((row) => row.batch_id))
      )
      expect(
        admissions.every(
          (entry) =>
            entry.outcome === 'returned' &&
            entry.rows === 1 &&
            entry.changes === 1 &&
            entry.params[1] === destination &&
            entry.params[2] === f.routeKey &&
            entry.params[4] === storedNonnegativeInteger(required(duties[0]).expires_at)
        )
      ).toBe(true)
      expect(work.every((entry) => entry.outcome === 'returned')).toBe(true)
      expect(
        f.activity.transactions
          .slice(txStart)
          .every((entry) => entry.outcome === 'committed' && entry.errors.length === 0)
      ).toBe(true)
      expect(await f.rows('push_batch_admissions')).toEqual([])
      expect(await f.rows('push_delivery_batches')).toEqual([])
    } catch (error) {
      primary = { failed: true, error }
    }
    const cleanup = ownerCleanup(primary)
    await cleanup.run(() => f.close())
    cleanup.finish()
  }
  expect(required(samples[1]).store, JSON.stringify(samples)).toBeLessThanOrEqual(
    required(samples[0]).store * 10
  )
})
