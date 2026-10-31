import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import type { ApnsRequest, ApnsResponse } from './apns-http2-transport.js'
import { DurablePushWorker } from './durable-push-worker.js'
import nacl from 'tweetnacl'
import { pushRouteDeclarationContent } from '@orca-cloud/push-contract'
import { PushDeviceRegistryStore } from './device-registry-store.js'
import { declarePushRoutes } from './push-route-declarations.js'
import { PushDispatcher } from './push-dispatcher.js'
import { ApnsClient } from './apns-client.js'
import { DurablePushStore } from './durable-push-store.js'
import { pushDestination } from './push-occurrence-admission.js'
import {
  cleanupDurablePushFixtures,
  durablePushTestDatabaseUrl,
  fixture,
  notification,
  within
} from './durable-push-store.test-fixture.js'

const A = 'AAAAAAAAAAAAAAAA'
const B = 'BBBBBBBBBBBBBBBB'
const origin = B
const occurrence = 'o'.repeat(43)
afterEach(cleanupDurablePushFixtures)

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) {
    throw new Error('Missing expected fixture value')
  }
  return value
}

async function setup() {
  const f = await fixture()
  const devices = new PushDeviceRegistryStore(f.db, f.clock)
  const key = nacl.sign.keyPair()
  const routeKey = Buffer.from(key.publicKey).toString('base64url')
  for (const hostFingerprint of [A, B]) {
    await devices.upsert({
      hostFingerprint,
      deviceId: 'phone',
      platform: 'ios',
      token: 'ab'.repeat(32),
      apnsEnvironment: 'production',
      routeKey
    })
  }
  const [maybeA] = await devices
    .findOwned(
      A,
      (await devices.list(A)).map((d) => d.registrationId)
    )
    .then((m) => [...m.values()])
  const [maybeB] = await devices
    .findOwned(
      B,
      (await devices.list(B)).map((d) => d.registrationId)
    )
    .then((m) => [...m.values()])
  const a = required(maybeA)
  const b = required(maybeB)
  const declare = async (hosts: string[], version = 1, signingKey = key) => {
    const body = {
      action: 'replace' as const,
      expectedVersion: version === 1 ? null : version - 1,
      v: 1 as const,
      platform: 'ios' as const,
      token: a.token,
      apnsEnvironment: 'production' as const,
      routeKey,
      version,
      hosts
    }
    return (
      (
        await declarePushRoutes(
          f.db,
          {
            ...body,
            signature: Buffer.from(
              nacl.sign.detached(
                Buffer.from(pushRouteDeclarationContent(body)),
                signingKey.secretKey
              )
            ).toString('base64url')
          },
          f.clock()
        )
      ).status === 200
    )
  }
  expect(await declare([A, B])).toBe(true)
  const alert = { ...notification(1), notificationId: 'subject', origin, occurrence }
  await f.store.accept(A, a.registrationId, alert)
  await f.store.accept(B, b.registrationId, alert)
  const first = required(await f.store.claim())
  const second = required(await f.store.claim())
  const device = (queued: typeof first) => (queued.hostFingerprint === A ? a : b)
  return { ...f, devices, declare, a, b, alert, first, second, device }
}

describe('occurrence admission', () => {
  it.skipIf(!durablePushTestDatabaseUrl).each(['sent', 'dismissed'] as const)(
    'waits for Postgres contention before committing %s without resending',
    async (outcome) => {
      const f = await setup()
      let attempted!: () => void
      const atAttempt = new Promise<void>((resolve) => (attempted = resolve))
      const contended = new DurablePushStore(
        {
          ...f.db,
          transaction: (run) =>
            f.db.transaction((tx) =>
              run({
                ...tx,
                lockScope: async (key) => {
                  attempted()
                  await tx.lockScope(key)
                }
              })
            )
        },
        f.clock
      )
      const admission = contended.admission(f.first)
      expect(await admission.acquire(f.device(f.first))).toBe('admitted')
      if (outcome === 'dismissed') {
        await f.store.defer(f.first)
      }
      let releaseAgain!: () => void
      const blockedAgain = new Promise<void>((resolve) => (releaseAgain = resolve))
      let heldAgain!: () => void
      const atHeldAgain = new Promise<void>((resolve) => (heldAgain = resolve))
      const blocker = f.db.transaction(async (tx) => {
        await tx.lockScope(
          `push-claim:${JSON.stringify([pushDestination(f.device(f.first)), f.device(f.first).routeKey, origin, occurrence])}`
        )
        heldAgain()
        await blockedAgain
      })
      await atHeldAgain
      const { origin: _origin, occurrence: _occurrence, ...legacy } = f.alert
      const completed =
        outcome === 'sent'
          ? admission.finalize(true)
          : contended.accept(f.first.hostFingerprint, f.first.registrationId, {
              ...legacy,
              kind: 'dismiss',
              notificationSeq: 2
            })
      try {
        await atAttempt
        expect(
          required((await f.db.query('SELECT state FROM push_occurrence_domains'))[0]).state
        ).toBe('inflight')
      } finally {
        releaseAgain()
        await blocker
      }
      await completed
      expect(
        required((await f.db.query('SELECT state FROM push_occurrence_domains'))[0]).state
      ).toBe(outcome)
      if (outcome === 'dismissed') {
        expect(
          await f.db.query('SELECT batch_id FROM push_delivery_batches WHERE batch_id = ?', [
            f.first.id
          ])
        ).toEqual([])
      }
      expect(await f.store.admission(f.second).acquire(f.device(f.second))).toBe('superseded')
    }
  )

  it('serializes expired takeover and fences a stale completion', async () => {
    const f = await setup()
    const stale = f.store.admission(f.first)
    expect(await stale.acquire(f.device(f.first))).toBe('admitted')
    f.advance(30_001)
    const reclaimed = [required(await f.store.claim()), required(await f.store.claim())]
    const successor = f.store.admission(required(reclaimed[0]))
    const peer = f.store.admission(required(reclaimed[1]))
    const results = await Promise.all([
      successor.acquire(f.device(required(reclaimed[0]))),
      peer.acquire(f.device(required(reclaimed[1])))
    ])
    expect(results.filter((result) => result === 'admitted')).toHaveLength(1)
    await stale.finalize(false)
    const row = required((await f.db.query('SELECT * FROM push_occurrence_domains'))[0])
    expect(row.attempt).not.toBe(f.first.lease)
    const index = results[0] === 'admitted' ? 0 : 1
    const admitted = index === 0 ? successor : peer
    await admitted.finalize(true)
    expect(await admitted.acquire(f.device(required(reclaimed[index])))).toBe('superseded')
  })

  it('keeps an in-flight dismissal monotonic when the provider then fails', async () => {
    const f = await setup()
    const winner = f.store.admission(f.first)
    expect(await winner.acquire(f.device(f.first))).toBe('admitted')
    const { origin: _origin, occurrence: _occurrence, ...legacy } = f.alert
    await f.store.accept(f.first.hostFingerprint, f.first.registrationId, {
      ...legacy,
      kind: 'dismiss',
      notificationSeq: 2
    })
    await winner.finalize(false)
    expect(await f.store.admission(f.second).acquire(f.device(f.second))).toBe('superseded')
    await f.store.accept(A, f.a.registrationId, { ...f.alert, notificationSeq: 1 })
    expect(required((await f.db.query('SELECT state FROM push_occurrence_domains'))[0]).state).toBe(
      'dismissed'
    )
  })

  it('lets a near-expiry waiter send after failure without consuming retry backoff', async () => {
    const f = await setup()
    const winner = f.store.admission(f.first)
    await winner.acquire(f.device(f.first))
    f.advance(299_500)
    await winner.renew()
    await f.store.renew(f.first)
    expect(await f.store.admission(f.second).acquire(f.device(f.second))).toBe('deferred')
    await f.store.defer(f.second)
    expect(await f.store.pendingCount(f.second.registrationId)).toBe(1)
    await winner.finalize(false)
    f.advance(499)
    const retried = required(await f.store.claim())
    expect(retried.attempts).toBe(1)
    expect(await f.store.admission(retried).acquire(f.device(retried))).toBe('admitted')
  })

  it('does not let a foreign route-key receipt suppress the phone', async () => {
    const f = await setup()
    const foreignKey = nacl.sign.keyPair()
    const foreign = Buffer.from(foreignKey.publicKey).toString('base64url')
    const initial = f.device(f.first)
    await f.devices.upsert({ ...initial, deviceId: 'phone', routeKey: foreign })
    const body = {
      action: 'replace' as const,
      expectedVersion: null,
      v: 1 as const,
      platform: 'ios' as const,
      token: initial.token,
      apnsEnvironment: 'production' as const,
      routeKey: foreign,
      version: 1,
      hosts: [initial.hostFingerprint]
    }
    expect(
      (
        await declarePushRoutes(
          f.db,
          {
            ...body,
            signature: Buffer.from(
              nacl.sign.detached(
                Buffer.from(pushRouteDeclarationContent(body)),
                foreignKey.secretKey
              )
            ).toString('base64url')
          },
          f.clock()
        )
      ).status
    ).toBe(200)
    const admitted = f.store.admission(f.first)
    expect(await admitted.acquire(required(await f.devices.findById(initial.registrationId)))).toBe(
      'admitted'
    )
    await admitted.finalize(true)
    expect(await f.store.admission(f.second).acquire(f.device(f.second))).toBe('admitted')
    expect(
      (await f.db.query('SELECT route_key FROM push_occurrence_domains'))
        .map((row) => row.route_key)
        .sort()
    ).toEqual([initial.routeKey, foreign].sort())
  })

  it.each([
    [A, A],
    [A, B],
    [B, A],
    [B, B]
  ])(
    'keeps the admitted copy with retained %s and first sender %s through provider settlement',
    async (retained, firstSender) => {
      const f = await setup()
      await f.declare([retained], 2)
      await parkBoth(f)
      await f.db.query('UPDATE push_delivery_batches SET due_at = ? WHERE host_fingerprint <> ?', [
        f.clock() + 1000,
        firstSender
      ])
      const requests: ApnsRequest[] = []
      const worker = new DurablePushWorker(
        f.store,
        new PushDispatcher({
          devices: f.devices,
          apns: provider(f.clock, async (request) => {
            requests.push(request)
            return { status: 200, body: '' }
          })
        }),
        { now: f.clock }
      )
      try {
        await worker.runDue()
        f.advance(1000)
        await worker.runDue()
        expect(requests).toHaveLength(2)
        const admitted = requests.find(
          (request) => JSON.parse(request.body).orca.origin === origin
        )!
        const legacy = requests.find((request) => !JSON.parse(request.body).orca.origin)!
        const skipped = retained === A ? B : A
        expect(JSON.parse(admitted.body).orca.hostFingerprint).toBe(retained)
        expect(JSON.parse(legacy.body).orca.hostFingerprint).toBe(skipped)
        expect(admitted.headers['apns-collapse-id']).not.toBe(legacy.headers['apns-collapse-id'])
        expect(legacy.headers['apns-collapse-id']).toBe(
          createHash('sha256')
            .update(JSON.stringify([skipped, 'subject']))
            .digest('hex')
        )
        expect(await f.store.pendingCount(f.a.registrationId)).toBe(0)
        expect(await f.store.pendingCount(f.b.registrationId)).toBe(0)
        expect(
          required((await f.db.query('SELECT state FROM push_occurrence_domains'))[0]).state
        ).toBe('sent')
      } finally {
        await worker.stop()
      }
    }
  )

  it.each([200, 400])(
    'parks five times, refunds attempts and settles after winner HTTP %s through provider retry',
    async (status) => {
      const f = await setup()
      await parkBoth(f)
      await f.db.query('UPDATE push_delivery_batches SET due_at = ? WHERE host_fingerprint = ?', [
        f.clock() + 1000,
        B
      ])
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let entered!: () => void
      const atProvider = new Promise<void>((resolve) => {
        entered = resolve
      })
      let park = Promise.withResolvers<void>()
      const defer = vi.spyOn(f.store, 'defer').mockImplementation(async (queued) => {
        await DurablePushStore.prototype.defer.call(f.store, queued)
        park.resolve()
      })
      const requests: ApnsRequest[] = []
      const onRetry = vi.fn()
      const worker = new DurablePushWorker(
        f.store,
        new PushDispatcher({
          devices: f.devices,
          apns: provider(f.clock, async (request) => {
            requests.push(request)
            if (requests.length === 1) {
              entered()
              await held
              return { status, body: '{"reason":"BadTopic"}' }
            }
            return { status: requests.length === 2 ? 503 : 200, body: '' }
          })
        }),
        { now: f.clock, onRetry }
      )
      const running = worker.runDue()
      const competing: Promise<void>[] = []
      try {
        await within(atProvider, 5000)
        for (let wait = 0; wait < 5; wait++) {
          f.advance(1000)
          competing.push(worker.runDue())
          await within(park.promise, 5000)
          park = Promise.withResolvers<void>()
          expect(defer).toHaveBeenCalledTimes(wait + 1)
          expect(await f.db.query('SELECT batch_id FROM push_batch_admissions')).toHaveLength(1)
        }
        expect(requests).toHaveLength(1)
        expect(onRetry).not.toHaveBeenCalled()
        const [maybeRow] = await f.db.query(
          'SELECT attempts, lease_token, due_at FROM push_delivery_batches WHERE host_fingerprint = ?',
          [B]
        )
        const row = required(maybeRow)
        expect(Number(row.attempts)).toBe(0)
        expect(row.lease_token).toBeNull()
        expect(Number(row.due_at)).toBe(f.clock() + 1000)
        release()
        await Promise.all([running, ...competing])
        if (status === 200) {
          expect(await f.declare([B], 2)).toBe(true)
        }
        f.advance(1000)
        await worker.runDue()
        expect(requests).toHaveLength(status === 200 ? 1 : 2)
        if (status === 400) {
          expect(JSON.parse(required(requests[1]).body).orca.hostFingerprint).toBe(B)
          const [waiting] = await f.db.query('SELECT attempts, due_at FROM push_delivery_batches')
          expect(Number(required(waiting).attempts)).toBe(1)
          expect(Number(required(waiting).due_at)).toBe(f.clock() + 2000)
          expect(onRetry).not.toHaveBeenCalled()
          f.advance(2000)
          await worker.runDue()
          expect(requests).toHaveLength(3)
          expect(onRetry).toHaveBeenCalledOnce()
        }
        expect(await f.store.pendingCount(f.a.registrationId)).toBe(0)
        expect(await f.store.pendingCount(f.b.registrationId)).toBe(0)
        expect(
          required((await f.db.query('SELECT state FROM push_occurrence_domains'))[0]).state
        ).toBe('sent')
      } finally {
        release()
        await Promise.all([running, ...competing])
        await worker.stop()
        defer.mockRestore()
      }
    }
  )

  it('retains a successful provider result while retrying fenced database finalization', async () => {
    const f = await setup()
    await f.store.finish(f.second)
    await f.store.defer(f.first)
    f.advance(1000)
    let failures = 0
    const store = new DurablePushStore(
      {
        ...f.db,
        transaction: (run) =>
          f.db.transaction((tx) =>
            run({
              ...tx,
              query: async (sql, params) => {
                if (
                  sql.startsWith("UPDATE push_occurrence_domains SET state = 'sent'") &&
                  failures++ < 2
                ) {
                  throw new Error('database temporarily unavailable')
                }
                return tx.query(sql, params)
              }
            })
          )
      },
      f.clock
    )
    const transport = vi.fn(async (_request: ApnsRequest) => ({ status: 200, body: '' }))
    const worker = new DurablePushWorker(
      store,
      new PushDispatcher({ devices: f.devices, apns: provider(f.clock, transport) }),
      { now: f.clock }
    )
    try {
      await worker.runDue()
      expect(transport).toHaveBeenCalledTimes(1)
      expect(failures).toBe(3)
      expect(await store.pendingCount(f.first.registrationId)).toBe(0)
      expect(
        required((await f.db.query('SELECT state FROM push_occurrence_domains'))[0]).state
      ).toBe('sent')
    } finally {
      await worker.stop()
    }
  })

  it('acknowledges lost declaration responses, orders versions, and rejects unproven declarations', async () => {
    const f = await setup()
    expect(await f.declare([B, A], 1)).toBe(true)
    expect(await f.declare([B], 1)).toBe(false)
    expect(await f.declare([B], 2, nacl.sign.keyPair())).toBe(false)
    expect(await f.declare([A], 2)).toBe(true)
    expect(await f.declare([B], 3)).toBe(true)
    expect(await f.declare([A, B], 2)).toBe(false)
    expect(
      required((await f.db.query('SELECT hosts_json FROM push_route_declarations'))[0]).hosts_json
    ).toBe(JSON.stringify([B]))
    await f.db.query('UPDATE push_devices SET route_key = NULL')
    expect(await f.declare([A, B], 4)).toBe(false)
    expect(
      await f.store.admission(f.first).acquire({ ...f.device(f.first), routeKey: undefined })
    ).toBe('skipped')
  })

  it('accepts a stripped resend after partial recipient acceptance', async () => {
    const f = await setup()
    const { origin: _origin, occurrence: _occurrence, ...legacy } = f.alert
    expect(await f.store.accept(A, 'another-phone', legacy)).toBe('queued')
  })
})

async function parkBoth(f: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await f.store.defer(f.first)
  await f.store.defer(f.second)
  f.advance(1000)
}

function provider(
  now: () => number,
  transport: (request: ApnsRequest) => Promise<ApnsResponse>
): ApnsClient {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  })
  return new ApnsClient({
    topic: 'com.stably.orca.mobile',
    credentials: { keyPem: privateKey, keyId: 'ABCDE12345', teamId: 'TEAM123456' },
    transport,
    now
  })
}

it.skipIf(!durablePushTestDatabaseUrl)(
  'serializes real signed route replacement against PG pruning without renewing replay or read',
  async () => {
    const f = await setup()
    const { createPushServer } = await import('./push-server.js')
    const { testPushConfig } = await import('./push-server-harness.test-fixture.js')
    const key = nacl.sign.keyPair()
    const routeKey = Buffer.from(key.publicKey).toString('base64url')
    await f.devices.upsert({
      hostFingerprint: A,
      deviceId: 'cap-race',
      platform: 'ios',
      token: f.a.token,
      apnsEnvironment: 'production',
      routeKey
    })
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    let hold = false
    const server = createPushServer(
      testPushConfig(),
      {
        ...f.db,
        transaction: (run) =>
          f.db.transaction((tx) =>
            run({
              ...tx,
              query: async (sql, params) => {
                const rows = await tx.query(sql, params)
                if (
                  hold &&
                  sql.includes('FROM push_route_declarations') &&
                  sql.endsWith(' FOR UPDATE')
                ) {
                  hold = false
                  entered.resolve()
                  await held.promise
                }
                return rows
              }
            })
          )
      },
      { now: f.clock }
    )
    const request = (
      operation:
        | { action: 'read' }
        | { action: 'replace'; version: number; expectedVersion: number | null; hosts: string[] }
    ) => {
      const body = {
        v: 1 as const,
        platform: 'ios' as const,
        apnsEnvironment: 'production' as const,
        token: f.a.token,
        routeKey,
        ...operation
      }
      return server.app.request('/v1/routes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...body,
          signature: Buffer.from(
            nacl.sign.detached(Buffer.from(pushRouteDeclarationContent(body)), key.secretKey)
          ).toString('base64url')
        })
      })
    }
    let pending: Promise<Response> | undefined
    let primary: { failed: true; error: unknown } | undefined
    try {
      expect(
        (await request({ action: 'replace', version: 1, expectedVersion: null, hosts: [A, B] }))
          .status
      ).toBe(200)
      f.advance(31 * 24 * 60 * 60_000)
      // Actual physical deletion has not run yet: reads must not invent a TTL absence.
      expect(await (await request({ action: 'read' })).json()).toEqual({
        status: 'current',
        version: 1,
        hosts: [A, B]
      })
      hold = true
      const replacing = Promise.resolve(
        request({ action: 'replace', version: 2, expectedVersion: 1, hosts: [B] })
      )
      pending = replacing
      await within(entered.promise, 5000)
      await f.store.prune() // SKIP LOCKED cannot delete the held current row
      held.resolve()
      expect((await replacing).status).toBe(200)
      const rows = await f.db.query(
        'SELECT updated_at FROM push_route_declarations WHERE route_key = ?',
        [routeKey]
      )
      expect(Number(required(rows[0]).updated_at)).toBe(f.clock())
      f.advance(1000)
      expect(
        (await request({ action: 'replace', version: 2, expectedVersion: 1, hosts: [B] })).status
      ).toBe(200)
      expect(
        await f.db.query('SELECT updated_at FROM push_route_declarations WHERE route_key = ?', [
          routeKey
        ])
      ).toEqual(rows)
      f.advance(31 * 24 * 60 * 60_000)
      await f.store.prune()
      expect(await (await request({ action: 'read' })).json()).toEqual({
        status: 'current',
        version: null,
        hosts: []
      })
      expect(
        (await request({ action: 'replace', version: 3, expectedVersion: 2, hosts: [A] })).status
      ).toBe(409)
    } catch (error) {
      primary = { failed: true, error }
    }
    const { ownerCleanup } = await import('./push-owner-integration.test-fixture.js')
    const cleanup = ownerCleanup(primary)
    await cleanup.run(() => held.resolve())
    await cleanup.run(() => pending)
    await cleanup.run(() => server.worker.stop())
    await cleanup.run(() => server.closeTransports())
    cleanup.finish()
  }
)
