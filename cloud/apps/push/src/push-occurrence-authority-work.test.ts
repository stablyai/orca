import { PRUNE_BATCH_ROWS, PRUNE_MAX_BATCHES } from './durable-push-store.js'
import { afterEach, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import {
  cleanupDurablePushFixtures,
  durablePushTestDatabaseUrl,
  within
} from './durable-push-store.test-fixture.js'
import { authorityFixture, required, TOKEN } from './push-occurrence-authority.test-fixture.js'
import { record, text, ownerCleanup } from './push-owner-integration.test-fixture.js'
import type { SqlRow } from './push-database.js'

afterEach(cleanupDurablePushFixtures)

function admissionRelation(rows: SqlRow[]) {
  return rows
    .map((row) => ({ ...row }))
    .toSorted(
      (left, right) =>
        text(left.batch_id).localeCompare(text(right.batch_id)) ||
        text(left.destination).localeCompare(text(right.destination)) ||
        text(left.route_key).localeCompare(text(right.route_key))
    )
}

it.each([false, true])(
  'bounds covered handoff C/V10/100 with P1, held provider=%s',
  async (hold) => {
    const samples: { count: number; queries: number; rows: number }[] = []
    for (const count of [10, 100]) {
      const entered = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      const f = await authorityFixture({
        provider: async () => {
          entered.resolve()
          if (hold) {
            await held.promise
          }
          return { status: 200, body: '' }
        }
      })
      let running: Promise<void> | undefined
      let primary: { failed: true; error: unknown } | undefined
      try {
        for (let seq = 1; seq <= count; seq++) {
          await f.send(f.a, f.alert(seq))
        }
        if (hold) {
          running = f.server.worker.runDue()
          await within(entered.promise, 5000)
        } else {
          const queued = required(await f.server.deliveryStore.claim())
          const admission = f.server.deliveryStore.admission(queued)
          expect(await admission.acquire(await f.device(f.a.registrationId))).toBe('admitted')
          await admission.finalize(false)
          await f.server.deliveryStore.finish(queued, 1000)
        }
        expect(f.requests).toHaveLength(hold ? 1 : 0)
        expect(await f.rows('push_batch_admissions')).toHaveLength(1)
        f.work.length = 0
        const lockStart = f.activity.advisory.length
        await f.send(f.a, f.read(count + 1))
        const work = [...f.work]
        const writes = work.filter((row) =>
          row.sql.startsWith('INSERT INTO push_occurrence_domains')
        )
        const history = work.filter((row) => row.sql.includes('JOIN push_delivery_batches b'))
        expect(writes).toHaveLength(count)
        expect(
          f.activity.advisory
            .slice(lockStart)
            .filter(
              (entry) =>
                (entry.method === 'lockScope' || entry.method === 'tryLockScope') &&
                entry.key.startsWith('push-claim:')
            )
        ).toHaveLength(count)
        expect(work.filter((row) => row.sql.startsWith('SELECT * FROM push_devices'))).toHaveLength(
          1
        )
        expect(work.filter((row) => row.sql.startsWith('SELECT version, hosts_json'))).toHaveLength(
          1
        )
        expect(history).toHaveLength(Math.ceil(count / 100))
        expect(history.reduce((sum, row) => sum + row.rows, 0)).toBe(1)
        expect(
          work.filter((row) => row.sql.startsWith('INSERT INTO push_batch_admissions'))
        ).toEqual([])
        expect(
          (await f.rows('push_occurrence_domains')).every((row) => row.state === 'dismissed')
        ).toBe(true)
        expect(await f.rows('push_delivery_batches')).toHaveLength(hold ? 2 : 1) // issued head and its local retraction
        samples.push({
          count,
          queries: work.length,
          rows: work.reduce((sum, row) => sum + row.rows, 0)
        })
        held.resolve()
        await running
        await f.settle()
        expect(f.requests).toHaveLength(hold ? 2 : 1)
        expect(record(record(JSON.parse(required(f.requests.at(-1)).body)).orca).kind).toBe(
          'dismiss'
        )
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
  }
)

it('bounds real admitted key churn by distinct live batch/domain facts and fenced finish', async () => {
  const samples: number[] = []
  for (const count of [10, 100]) {
    const f = await authorityFixture()
    const associationBytes: number[] = []
    let primary: { failed: true; error: unknown } | undefined
    try {
      await f.send(f.a, f.alert())
      const queued = required(await f.server.deliveryStore.claim())
      const originalExpiry = queued.expiresAt
      for (let index = 0; index < count; index++) {
        f.advance(2000)
        const live = required((await f.rows('push_delivery_batches'))[0])
        expect(live.batch_id).toBe(queued.id)
        expect(live.lease_token).toBe(queued.lease)
        expect(Number(live.lease_until)).toBeGreaterThan(f.clock())
        expect(Number(live.expires_at)).toBe(originalExpiry)
        expect(f.clock()).toBeLessThan(originalExpiry)
        await f.server.deliveryStore.renew(queued)
        expect(Number(required((await f.rows('push_delivery_batches'))[0]).lease_until)).toBe(
          f.clock() + 30_000
        )
        const key = nacl.sign.keyPair()
        await f.register(f.a.session, TOKEN, Buffer.from(key.publicKey).toString('base64url'))
        await f.declare([f.a.host], 1, key)
        const admission = f.server.deliveryStore.admission(queued)
        const start = f.work.length
        expect(await admission.acquire(await f.device(f.a.registrationId))).toBe('admitted')
        const insertion = required(
          f.work
            .slice(start)
            .find((entry) => entry.sql.startsWith('INSERT INTO push_batch_admissions'))
        )
        expect(insertion.params).toHaveLength(5)
        expect(insertion.changes).toBe(1)
        expect(insertion.rows).toBe(1) // Driver mutation receipt, not a stored-row scan.
        expect(insertion.returnedBytes).toBe(Buffer.byteLength(JSON.stringify([{ changes: 1 }])))
        associationBytes.push(insertion.parameterBytes)
        const repeatStart = f.work.length
        const admitted = admissionRelation(await f.rows('push_batch_admissions'))
        await admission.renew()
        await admission.renew()
        expect(Number(required((await f.rows('push_occurrence_domains'))[0]).lease_until)).toBe(
          f.clock() + 30_000
        )
        await f.server.worker.runDue()
        expect(admissionRelation(await f.rows('push_batch_admissions'))).toEqual(admitted)
        expect(await admission.acquire(await f.device(f.a.registrationId))).toBe('admitted')
        expect(admissionRelation(await f.rows('push_batch_admissions'))).toEqual(admitted)
        const repeats = f.work
          .slice(repeatStart)
          .filter((entry) => entry.sql.startsWith('INSERT INTO push_batch_admissions'))
        expect(repeats).toHaveLength(1)
        expect(required(repeats[0]).parameterBytes).toBe(insertion.parameterBytes)
        expect(admitted).toHaveLength(index + 1)
        await admission.finalize(false)
      }
      expect(new Set(associationBytes).size).toBe(1)
      expect(associationBytes.reduce((sum, bytes) => sum + bytes, 0)).toBe(
        required(associationBytes[0]) * count
      )
      const proof = admissionRelation(await f.rows('push_batch_admissions'))
      expect(new Set(proof.map((row) => row.route_key)).size).toBe(count)
      expect(
        proof.every(
          (row) => row.batch_id === queued.id && Number(row.expires_at) === queued.expiresAt
        )
      ).toBe(true)
      await f.server.deliveryStore.finish({ ...queued, lease: 'not-the-owner' })
      expect(admissionRelation(await f.rows('push_batch_admissions'))).toEqual(proof)
      f.work.length = 0
      const lockStart = f.activity.advisory.length
      await f.send(f.a, f.read())
      expect(
        f.work
          .filter((row) => row.sql.includes('JOIN push_delivery_batches b'))
          .reduce((sum, row) => sum + row.rows, 0)
      ).toBe(count)
      const history = f.work.filter((row) => row.sql.includes('JOIN push_delivery_batches b'))
      expect(history).toHaveLength(1)
      expect(required(history[0]).returnedBytes).toBe(
        Buffer.byteLength(
          JSON.stringify(
            proof.map((row) => ({
              batch_id: row.batch_id,
              destination: row.destination,
              route_key: row.route_key
            }))
          )
        )
      )
      expect(
        f.work.filter((row) => row.sql.startsWith('INSERT INTO push_occurrence_domains'))
      ).toHaveLength(count)
      expect(
        f.activity.advisory
          .slice(lockStart)
          .filter(
            (entry) =>
              (entry.method === 'lockScope' || entry.method === 'tryLockScope') &&
              entry.key.startsWith('push-claim:')
          )
      ).toHaveLength(count)
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
    try {
      const failure = (value: unknown) => {
        const details = value && typeof value === 'object' ? value : {}
        return Object.fromEntries(
          ['name', 'message', 'code', 'routine'].map((key) => [key, Reflect.get(details, key)])
        )
      }
      const orphans = f.work.flatMap((entry, workIndex) =>
        entry.sql.startsWith('DELETE FROM push_batch_admissions') &&
        entry.sql.includes('expires_at <= ? AND NOT EXISTS')
          ? [{ entry, workIndex }]
          : []
      )
      console.error(
        'Orphan cleanup failure receipt',
        JSON.stringify({
          primary: failure(error),
          work: Object.fromEntries(
            ['entered', 'returned', 'error'].map((outcome) => [
              outcome,
              f.work.filter((entry) => entry.outcome === outcome).length
            ])
          ),
          orphans: {
            total: orphans.length,
            outcomes: Object.fromEntries(
              ['entered', 'returned', 'error'].map((outcome) => [
                outcome,
                orphans.filter(({ entry }) => entry.outcome === outcome).length
              ])
            ),
            returnedChanges: orphans.reduce(
              (sum, { entry }) => sum + (entry.outcome === 'returned' ? entry.changes : 0),
              0
            ),
            omitted: Math.max(0, orphans.length - 3),
            last: orphans.slice(-3).map(({ entry, workIndex }, offset) => ({
              workIndex,
              ordinal: Math.max(0, orphans.length - 3) + offset + 1,
              sql: entry.sql,
              outcome: entry.outcome,
              binding:
                entry.params.length === 1 &&
                typeof entry.params[0] === 'number' &&
                Number.isSafeInteger(entry.params[0])
                  ? entry.params[0]
                  : 'invalid numeric binding',
              returnedChanges: entry.outcome === 'returned' ? entry.changes : null,
              error: failure(entry.error)
            }))
          },
          transactions: {
            outcomes: Object.fromEntries(
              ['entered', 'committed', 'error'].map((outcome) => [
                outcome,
                f.activity.transactions.filter((entry) => entry.outcome === outcome).length
              ])
            ),
            attempts: f.activity.transactions.reduce((sum, entry) => sum + entry.attempts, 0),
            attemptErrors: f.activity.transactions.reduce(
              (sum, entry) => sum + entry.errors.length,
              0
            )
          },
          advisory: Object.fromEntries(
            ['entered', 'returned', 'error'].map((outcome) => [
              outcome,
              f.activity.advisory.filter((entry) => entry.outcome === outcome).length
            ])
          )
        })
      )
    } catch {
      // A diagnostic failure must not replace the primary failure.
    }
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
