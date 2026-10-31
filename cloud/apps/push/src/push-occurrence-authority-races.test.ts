import { afterEach, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import { createHash } from 'node:crypto'
import {
  cleanupDurablePushFixtures,
  durablePushTestDatabaseUrl,
  within
} from './durable-push-store.test-fixture.js'
import {
  authorityFixture,
  NEXT_TOKEN,
  required,
  TOKEN
} from './push-occurrence-authority.test-fixture.js'
import { drainPopulations } from './push-occurrence-settlement.test-fixture.js'
import { createPushServer } from './push-server.js'
import { testPushConfig } from './push-server-harness.test-fixture.js'
import type { ApnsRequest } from './apns-http2-transport.js'
import { record, ownerCleanup } from './push-owner-integration.test-fixture.js'

afterEach(cleanupDurablePushFixtures)

type ProviderAttempt = {
  phase: 'original' | 'restarted'
  status: 200 | 503
  host: string
  path: string
  pushType: string | undefined
  collapse: string | undefined
  body: Record<string, unknown>
}
function providerAttempt(
  request: ApnsRequest,
  phase: ProviderAttempt['phase'],
  status: ProviderAttempt['status']
): ProviderAttempt {
  return {
    phase,
    status,
    host: request.host,
    path: request.path,
    pushType: request.headers['apns-push-type'],
    collapse: request.headers['apns-collapse-id'],
    body: record(JSON.parse(request.body))
  }
}

it.each(['before-failure', 'after-failure'] as const)(
  'retains actual admitted historical authority after removal/read %s and restart',
  async (order) => {
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const transcript: ProviderAttempt[] = []
    const f = await authorityFixture({
      provider: async (request) => {
        entered.resolve()
        await held.promise
        const response = { status: 503 as const, body: '' }
        transcript.push(providerAttempt(request, 'original', response.status))
        return response
      }
    })
    let running: Promise<void> | undefined
    let restarted: ReturnType<typeof createPushServer> | undefined
    let primary: { failed: true; error: unknown } | undefined
    try {
      await f.send(f.a, f.alert())
      running = f.server.worker.runDue()
      await within(entered.promise, 5000)
      expect(await f.rows('push_batch_admissions')).toEqual([
        expect.objectContaining({ route_key: f.routeKey, attempt: expect.any(String) })
      ])
      await f.declare([f.b.host], 2)
      if (order === 'after-failure') {
        held.resolve()
        await running
        expect(await f.rows('push_occurrence_domains')).toEqual([])
      }
      await f.send(f.a, f.read())
      held.resolve()
      await running
      await f.server.worker.stop()
      const restartedRequests: ApnsRequest[] = []
      restarted = createPushServer(testPushConfig(), f.database, {
        now: f.clock,
        apnsTransport: async (request) => {
          restartedRequests.push(request)
          const response = { status: 200 as const, body: '' }
          transcript.push(providerAttempt(request, 'restarted', response.status))
          return response
        }
      })
      expect((await f.rows('push_occurrence_domains')).map((row) => row.state)).toEqual([
        'dismissed'
      ])
      await f.send(f.b, f.alert())
      f.advance(2000)
      await drainPopulations(
        { ...f, server: restarted, requests: restartedRequests },
        `restart/${order}`
      )
      const tuple = {
        hostFingerprint: f.a.host,
        notificationId: 'subject',
        notificationEpoch: 'epoch',
        source: 'agent-task-complete',
        agentState: 'finished'
      }
      const destination = { host: 'api.push.apple.com', path: `/3/device/${TOKEN}` }
      const alert: ProviderAttempt = {
        ...destination,
        phase: 'original',
        status: 503,
        pushType: 'alert',
        collapse: createHash('sha256')
          .update(JSON.stringify(['admitted-v1', f.b.host, 'subject']))
          .digest('hex'),
        body: {
          aps: { alert: { title: 'Done', body: '' }, sound: 'default', 'thread-id': f.a.host },
          orca: {
            ...tuple,
            kind: 'alert',
            notificationSeq: 1,
            origin: f.b.host,
            occurrence: f.alert().occurrence
          }
        }
      }
      const dismissal: ProviderAttempt = {
        ...destination,
        phase: 'restarted',
        status: 200,
        pushType: 'background',
        collapse: undefined,
        body: {
          aps: { 'content-available': 1 },
          orca: { ...tuple, kind: 'dismiss', notificationSeq: 2 }
        }
      }
      expect(transcript).toEqual(
        order === 'before-failure'
          ? [alert, { ...dismissal, phase: 'original', status: 503 }, dismissal]
          : [alert, dismissal]
      )
      expect(f.requests).toHaveLength(transcript.length - restartedRequests.length)
      expect(await f.rows('push_delivery_batches')).toEqual([])
      expect(await f.rows('push_batch_admissions')).toEqual([])
    } catch (error) {
      primary = { failed: true, error }
    }
    const cleanup = ownerCleanup(primary)
    await cleanup.run(() => held.resolve())
    await cleanup.run(() => running)
    await cleanup.run(() => restarted?.worker.stop())
    await cleanup.run(() => restarted?.closeTransports())
    await cleanup.run(() => f.close())
    cleanup.finish()
  }
)

it.each([false, true])(
  'binds historical D1/K1 while current D2/K2 independently authorizes A=%s',
  async (authorize) => {
    const f = await authorityFixture()
    let primary: { failed: true; error: unknown } | undefined
    try {
      await f.send(f.a, f.alert())
      const first = required(await f.server.deliveryStore.claim())
      const stale = f.server.deliveryStore.admission(first)
      expect(await stale.acquire(await f.device(f.a.registrationId))).toBe('admitted')
      await stale.finalize(false)
      const key2 = nacl.sign.keyPair()
      const routeKey2 = Buffer.from(key2.publicKey).toString('base64url')
      for (const actor of [f.a, f.b]) {
        await f.register(actor.session, NEXT_TOKEN, routeKey2)
      }
      await f.declare(authorize ? [f.a.host, f.b.host] : [f.b.host], 1, key2, NEXT_TOKEN)
      await f.send(f.a, f.read())
      await stale.finalize(true)
      await stale.renew()
      const rows = await f.rows('push_occurrence_domains')
      expect(rows.find((row) => row.route_key === f.routeKey)?.state).toBe('dismissed')
      expect(rows.find((row) => row.route_key === routeKey2)?.state).toBe(
        authorize ? 'dismissed' : undefined
      )
      await f.server.deliveryStore.finish(first)
      await f.send(f.b, f.alert())
      await f.settle()
      const alerts = f.requests.filter(
        (request) => record(record(JSON.parse(request.body)).orca).kind !== 'dismiss'
      )
      expect(alerts).toHaveLength(authorize ? 0 : 1)
      if (!authorize) {
        expect(required(alerts[0]).path).toContain(NEXT_TOKEN)
      }
      expect(await f.rows('push_delivery_batches')).toEqual([])
      expect(await f.rows('push_batch_admissions')).toEqual([])
    } catch (error) {
      primary = { failed: true, error }
    }
    const cleanup = ownerCleanup(primary)
    await cleanup.run(() => f.close())
    cleanup.finish()
  }
)

it('uses fresh T2 current authority for a T1-accepted batch and hands off read between lease and acquire', async () => {
  const f = await authorityFixture()
  let primary: { failed: true; error: unknown } | undefined
  try {
    await f.send(f.a, f.alert())
    await f.send(f.b, f.alert())
    const leased = required(await f.server.deliveryStore.claim())
    for (const actor of [f.a, f.b]) {
      await f.register(actor.session, NEXT_TOKEN)
    }
    await f.declare([f.a.host, f.b.host], 1, f.key, NEXT_TOKEN)
    await f.send(f.a, f.read())
    expect(
      await f.server.deliveryStore.admission(leased).acquire(await f.device(leased.registrationId))
    ).toBe('superseded')
    await f.server.deliveryStore.finish(leased)
    await f.settle()
    expect(
      f.requests.every(
        (request) => record(record(JSON.parse(request.body)).orca).kind === 'dismiss'
      )
    ).toBe(true)
    expect(await f.rows('push_delivery_batches')).toEqual([])
    expect(await f.rows('push_batch_admissions')).toEqual([])
  } catch (error) {
    primary = { failed: true, error }
  }
  const cleanup = ownerCleanup(primary)
  await cleanup.run(() => f.close())
  cleanup.finish()
})

it.skipIf(!durablePushTestDatabaseUrl)(
  'protects actual PG provider snapshot through concurrent registration and sends outside the transaction',
  async () => {
    const entered = Promise.withResolvers<void>()
    const updating = Promise.withResolvers<void>()
    const resolved = Promise.withResolvers<void>()
    const readRelease = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    let holdResolved = false
    let pause = false
    let watchChange = false
    let snapshotOpen = false
    const f = await authorityFixture({
      provider: async () => {
        expect(snapshotOpen).toBe(false)
        return { status: 200, body: '' }
      },
      database: (db) => ({
        ...db,
        query: async (sql, params) => {
          const rows = await db.query(sql, params)
          if (holdResolved && sql.includes('FROM push_devices WHERE registration_id = ?')) {
            holdResolved = false
            resolved.resolve()
            await readRelease.promise
          }
          return rows
        },
        transaction: async (run) => {
          let protectedSnapshot = false
          try {
            return await db.transaction((tx) =>
              run({
                ...tx,
                query: async (sql, params) => {
                  if (watchChange && sql.startsWith('UPDATE push_devices')) {
                    updating.resolve()
                  }
                  const rows = await tx.query(sql, params)
                  if (
                    pause &&
                    sql.includes('FROM push_devices') &&
                    sql.endsWith('FOR SHARE SKIP LOCKED')
                  ) {
                    pause = false
                    protectedSnapshot = true
                    snapshotOpen = true
                    entered.resolve()
                    await held.promise
                  }
                  return rows
                }
              })
            )
          } finally {
            if (protectedSnapshot) {
              snapshotOpen = false
            }
          }
        }
      })
    })
    let running: Promise<void> | undefined
    let changed: Promise<string> | undefined
    let primary: { failed: true; error: unknown } | undefined
    try {
      await f.send(f.a, f.alert())
      holdResolved = true
      running = f.server.worker.runDue()
      await within(resolved.promise, 5000)
      await f.register(f.a.session, NEXT_TOKEN)
      await f.declare([f.a.host, f.b.host], 1, f.key, NEXT_TOKEN)
      readRelease.resolve()
      await running
      expect(f.requests).toEqual([])
      expect(await f.rows('push_batch_admissions')).toEqual([])
      expect(await f.rows('push_occurrence_domains')).toEqual([])
      const parkedRows = await f.rows('push_delivery_batches')
      expect(parkedRows).toHaveLength(1)
      const parked = required(parkedRows[0])
      expect(Number(parked.attempts)).toBe(0)
      expect(parked.lease_token).toBeNull()
      expect(Number(parked.due_at)).toBe(f.clock() + 1000)
      f.advance(1000)
      pause = true
      running = f.server.worker.runDue()
      await within(entered.promise, 5000)
      watchChange = true
      changed = f.register(f.a.session, TOKEN)
      await within(updating.promise, 5000)
      held.resolve()
      await within(Promise.all([running, changed]), 5000)
      expect(f.requests).toHaveLength(1)
      expect(required(f.requests[0]).path).toBe(`/3/device/${NEXT_TOKEN}`)
      expect((await f.device(f.a.registrationId)).token).toBe(TOKEN)
      expect(await f.rows('push_delivery_batches')).toEqual([])
    } catch (error) {
      primary = { failed: true, error }
    }
    const cleanup = ownerCleanup(primary)
    await cleanup.run(() => readRelease.resolve())
    await cleanup.run(() => held.resolve())
    await cleanup.run(() => Promise.all([running, changed]))
    await cleanup.run(() => f.close())
    cleanup.finish()
  }
)
