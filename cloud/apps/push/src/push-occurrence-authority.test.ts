import { afterEach, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import { cleanupDurablePushFixtures } from './durable-push-store.test-fixture.js'
import { authorityFixture, TOKEN } from './push-occurrence-authority.test-fixture.js'
import { drainPopulations } from './push-occurrence-settlement.test-fixture.js'
import { record, ownerCleanup } from './push-owner-integration.test-fixture.js'

afterEach(cleanupDurablePushFixtures)

it.each(['excluded', 'keyless', 'foreign'] as const)(
  'keeps %s sender retirement local in both accept orders through actual provider settlement',
  async (mode) => {
    for (const reversed of [false, true]) {
      const f = await authorityFixture()
      let primary: { failed: true; error: unknown } | undefined
      try {
        await f.declare([f.b.host], 2)
        if (mode === 'keyless') {
          await f.register(f.a.session, TOKEN, null)
        }
        if (mode === 'foreign') {
          const foreign = nacl.sign.keyPair()
          await f.register(f.a.session, TOKEN, Buffer.from(foreign.publicKey).toString('base64url'))
          await f.declare([f.a.host], 1, foreign)
        }
        for (const actor of reversed ? [f.b, f.a] : [f.a, f.b]) {
          await f.send(actor, f.alert())
        }
        await f.send(f.a, f.read())
        expect(
          (await f.rows('push_delivery_batches')).filter(
            (row) => row.kind === 'alert' && row.host_fingerprint === f.a.host
          )
        ).toEqual([])
        expect(
          (await f.rows('push_occurrence_domains')).filter((row) => row.route_key === f.routeKey)
        ).toEqual([])
        await f.settle()
        const bodies = f.requests
          .map((request) => record(JSON.parse(request.body)).orca)
          .map(record)
        expect(bodies.filter((body) => body.kind !== 'dismiss')).toEqual([
          expect.objectContaining({
            hostFingerprint: f.b.host,
            origin: f.b.host,
            occurrence: f.alert().occurrence
          })
        ])
        expect(bodies.filter((body) => body.kind === 'dismiss')).toEqual([
          expect.objectContaining({ hostFingerprint: f.a.host })
        ])
        expect(
          (await f.rows('push_occurrence_domains')).filter((row) => row.route_key === f.routeKey)
        ).toEqual([expect.objectContaining({ state: 'sent' })])
        expect(await f.rows('push_delivery_batches')).toEqual([])
        expect(await f.rows('push_batch_admissions')).toEqual([])
      } catch (error) {
        primary = { failed: true, error }
      }
      const cleanup = ownerCleanup(primary)
      await cleanup.run(() => f.close())
      cleanup.finish()
    }
  }
)

it('qualifies a current no-row and late-covered read without borrowing acceptance or sliding retention', async () => {
  const f = await authorityFixture()
  let primary: { failed: true; error: unknown } | undefined
  try {
    await f.send(f.a, f.read())
    await f.send(f.b, f.alert())
    await f.send(f.a, f.alert())
    const before = await f.rows('push_occurrence_domains')
    expect(before).toEqual([expect.objectContaining({ state: 'dismissed', route_key: f.routeKey })])
    f.advance(1000)
    await f.send(f.a, f.read(3))
    expect(await f.rows('push_occurrence_domains')).toEqual(before)
    const foreign = nacl.sign.keyPair()
    await f.register(f.a.session, TOKEN, Buffer.from(foreign.publicKey).toString('base64url'))
    await f.declare([f.a.host], 1, foreign)
    f.advance(1)
    await f.send(f.a, f.alert(4))
    await drainPopulations(f, 'current-no-row/foreign-key')
    await f.register(f.a.session)
    await f.send(f.b, { ...f.alert(), notificationSeq: 4 })
    await f.settle()
    expect(
      f.requests
        .map((request) => record(record(JSON.parse(request.body)).orca))
        .map((body) => (body.kind === 'dismiss' ? 'dismiss' : body.occurrence))
    ).toEqual(['dismiss', 'dismiss', f.alert(4).occurrence])
    expect(
      (await f.rows('push_occurrence_domains')).find((row) => row.route_key === f.routeKey)
    ).toEqual(before[0])
    expect(await f.rows('push_delivery_batches')).toEqual([])
    expect(await f.rows('push_batch_admissions')).toEqual([])
  } catch (error) {
    primary = { failed: true, error }
  }
  const cleanup = ownerCleanup(primary)
  await cleanup.run(() => f.close())
  cleanup.finish()
})
