import {
  createRouteDeclarationFixture,
  routeDeclarationPorts,
  hosts,
  requests,
  notifyCatalog,
  settle
} from './push-route-declaration-ports.test-fixture'
import * as SecureStore from 'expo-secure-store'
import { expect, it, vi } from 'vitest'

const fixture = createRouteDeclarationFixture()
const state = routeDeclarationPorts()
const token = state.token
const register = fixture.register

import nacl from 'tweetnacl'
import { PushRouteDeclarationSchema } from '../../../cloud/packages/push-contract/src/route-declaration'
import { pushRouteDeclarationContent } from '../../../cloud/packages/push-contract/src/route-declaration-content'

it('persists signed replacements before issue, retries lost commit bytes, and withdraws only genuine empty', async () => {
  const { bodies, operations, send, respond } = requests()
  let lost = false
  send.mockImplementation(async (_url, init) => {
    const response = respond(init)
    if (
      !lost &&
      PushRouteDeclarationSchema.parse(JSON.parse(String(init?.body))).action === 'replace'
    ) {
      lost = true
      throw new Error('committed response lost')
    }
    return response
  })
  await register('https://untrusted.invalid')
  await settle()
  // Untrusted RPC result grants no membership; the authenticated read is the authority.
  await register()
  await vi.advanceTimersByTimeAsync(1000)
  expect(operations.filter((body) => body.action === 'read')).toHaveLength(1)
  expect(bodies).toHaveLength(2)
  const first = bodies.at(0)
  if (!first) {
    throw new Error('Missing signed replace')
  }
  expect(bodies[1]).toEqual(first)
  const immutableBytes = send.mock.calls
    .filter(
      ([, init]) =>
        PushRouteDeclarationSchema.parse(JSON.parse(String(init?.body))).action === 'replace'
    )
    .map(([, init]) => init?.body)
  expect(immutableBytes).toEqual([JSON.stringify(first), JSON.stringify(first)])
  expect(Number(state.storage.get('orca:push-route-version'))).toBe(first.version)
  expect(
    nacl.sign.detached.verify(
      Buffer.from(pushRouteDeclarationContent(first)),
      Buffer.from(first.signature, 'base64url'),
      Buffer.from(first.routeKey, 'base64url')
    )
  ).toBe(true)
  hosts(0)
  await notifyCatalog()
  await settle()
  expect(bodies.at(-1)?.version).toBeGreaterThan(first.version)
  expect(bodies.at(-1)?.hosts).toEqual([])
})

it('retains immutable transport bytes with one due renewal and reads again only after acceptance', async () => {
  const { bodies, operations, send, respond } = requests()
  let failing = true
  send.mockImplementation(async (_url, init) =>
    respond(
      init,
      PushRouteDeclarationSchema.parse(JSON.parse(String(init?.body))).action === 'replace' &&
        failing
        ? 503
        : 200
    )
  )
  await register()
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  const first = bodies.at(0)
  if (!first) {
    throw new Error('Missing immutable replace')
  }
  expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(first))).toBe(true)
  expect(operations.filter((body) => body.action === 'read')).toHaveLength(1)
  expect(state.loads).toBe(1)
  failing = false
  await vi.advanceTimersByTimeAsync(60_000)
  expect(bodies.at(-1)?.version).toBeGreaterThan(first.version)
  expect(operations.filter((body) => body.action === 'read')).toHaveLength(2)
  expect(state.loads).toBe(2)
  const settled = send.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(send).toHaveBeenCalledTimes(settled)
})

it('reconstructs saved key/floor and removes an unreachable host after disconnected restart', async () => {
  hosts(2)
  const { bodies } = requests()
  await register()
  const prior = bodies.at(0)
  if (!prior) {
    throw new Error('Missing initial replacement')
  }
  fixture.stop?.()
  const registration = await import('./push-registration')
  fixture.stop = registration.startPushTokenSync()
  await settle()
  expect(bodies.at(-1)?.version).toBeGreaterThan(prior.version)
  expect(bodies.at(-1)?.routeKey).toBe(prior.routeKey)
  await (
    await import('../transport/host-removal-lifecycle')
  ).removeHostAndCloseClient('host-0', vi.fn())
  await settle()
  expect(bodies.at(-1)?.hosts).toHaveLength(1)
  const profiles = JSON.parse(state.storage.get('orca:hosts') ?? '[]')
  expect(profiles).toHaveLength(1)
  fixture.stop()
  fixture.stop = registration.startPushTokenSync()
  await settle()
  expect(bodies.at(-1)?.hosts).toHaveLength(1)
  expect(bodies.at(-1)?.version).toBeGreaterThan(prior.version)
})

it('parks no-live/unsupported/invalid-contract, preserves a genuine registration wake racing refusal, and retries transient bytes', async () => {
  const { send, respond } = requests()
  const gate = Promise.withResolvers<Response>()
  send.mockImplementationOnce(() => gate.promise)
  await register()
  await register()
  gate.resolve(new Response('{"error":"no_live_registration"}', { status: 403 }))
  await settle()
  expect(send).toHaveBeenCalledTimes(3) // refused read, reconstructed read, accepted replace
  for (const code of [400, 404, 403, 429, 503]) {
    send.mockImplementation(async (_url, init) => respond(init, code))
    hosts(code)
    await notifyCatalog()
    await settle()
    const before = send.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(before + (code === 429 || code === 503 ? 1 : 0))
  }
  send.mockImplementation(async (_url, init) => respond(init, 404))
  hosts(1)
  await notifyCatalog()
  await settle()
  const parked = send.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(send).toHaveBeenCalledTimes(parked)
  send.mockImplementation(async (_url, init) => respond(init))
  await register()
  await settle()
  expect(send).toHaveBeenCalledTimes(parked + 2)
})

it.each([
  { count: 4, changes: 0, phase: 'initial' },
  { count: 40, changes: 0, phase: 'initial' },
  ...['initial', 'fresh', 'issued'].flatMap((phase) => [
    { count: 4, changes: 10, phase },
    { count: 40, changes: 100, phase }
  ])
])(
  'bounds actual startup/probe/listener/lease interests for $count hosts and $changes changes behind $phase',
  async ({ count, changes, phase }) => {
    state.keys.clear()
    state.metadataReads = 0
    state.metadataWrites = 0
    vi.resetModules()
    fixture.publisher = await import('./push-route-declaration')
    vi.mocked(SecureStore.getItemAsync).mockClear()
    vi.mocked(SecureStore.setItemAsync).mockClear()
    const heldRead = Promise.withResolvers<string | null>()
    if (phase === 'initial') {
      vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(() => heldRead.promise)
    } else if (phase === 'fresh') {
      vi.mocked(SecureStore.getItemAsync)
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(() => heldRead.promise)
    } else {
      vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
        await heldRead.promise
        state.keys.set(key, value)
      })
    }
    hosts(count)
    const source = await import('./push-route-declaration-build')
    const prepare = fixture.publisher.mobilePushRouteKey
    const interests: {
      handle: ReturnType<typeof prepare>
      predicate: ReturnType<typeof vi.fn<() => boolean>>
      retired: boolean
      calls: number
    }[] = []
    const preparations = vi
      .spyOn(fixture.publisher, 'mobilePushRouteKey')
      .mockImplementation((current) => {
        const predicate = vi.fn(current)
        const handle = prepare(predicate)
        const interest = { handle, predicate, retired: false, calls: 0 }
        interests.push(interest)
        void handle.result.then((result) => {
          if (result.status === 'retired') {
            interest.retired = true
            interest.calls = predicate.mock.calls.length
          }
        })
        return handle
      })
    const { send } = requests()
    const fingerprint = await import('./push-host-fingerprint')
    const hashes = vi.spyOn(fingerprint, 'deriveHostFingerprint')
    const signs = vi.spyOn(nacl.sign, 'detached')
    const { getDevicePushToken } = await import('./push-token')
    const filters = vi.spyOn(
      await import('./notification-delivery-preferences'),
      'loadNotificationDeliveryPreferences'
    )
    const consentReads = vi.spyOn(
      await import('../storage/preferences'),
      'readPushNotificationsPreference'
    )
    const registration = await import('./push-registration')
    const replies = Array.from({ length: count }, () => Promise.withResolvers<void>())
    const clients = replies.map((gate) => ({
      sendRequest: vi.fn(async (method: string) => {
        if (method !== 'status.get') {
          await gate.promise
        }
        return {
          id: 'req',
          ok: true as const,
          result:
            method === 'status.get'
              ? {
                  capabilities: [
                    registration.NOTIFICATIONS_REMOTE_PUSH_CAPABILITY,
                    'notifications.push-route-key.v1'
                  ]
                }
              : { registered: true, gatewayOrigin: 'https://push.onorca.dev' }
        }
      })
    }))
    clients.forEach((client, i) => registration.attachPushRegistration(`host-${i}`, client))
    await settle()
    expect(getDevicePushToken).not.toHaveBeenCalled()
    fixture.stop = registration.startPushTokenSync()
    await settle()
    expect(preparations).toHaveBeenCalledTimes(count)
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(phase === 'initial' ? 1 : 2)
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(phase === 'issued' ? 1 : 0)
    const upstream: { filters: number; consent: number }[] = []
    for (let i = 0; i < changes; i++) {
      const beforeFilters = filters.mock.calls.length
      const beforeConsent = consentReads.mock.calls.length
      state.callbacks.listener?.({ ...token, token: (i + 1).toString(16).padStart(64, '0') })
      await settle()
      expect(source.pushRoutePreparationSnapshotForTests()).toMatchObject({
        keyEntries: count + 1,
        keyTask: 1,
        creator: 0,
        creatorCells: phase === 'initial' ? 0 : 1,
        builder: 1,
        latest: 0,
        builderCallables: 1
      })
      expect(registration.pushRegistrationSnapshotForTests()).toEqual({
        preparations: count,
        runners: count
      })
      upstream.push({
        filters: filters.mock.calls.length - beforeFilters,
        consent: consentReads.mock.calls.length - beforeConsent
      })
      const before = preparations.mock.calls.length
      state.callbacks.listener?.({ ...token, token: (i + 1).toString(16).padStart(64, '0') })
      await settle()
      expect(preparations).toHaveBeenCalledTimes(before)
      expect(interests.filter((interest) => interest.retired)).toHaveLength(count * (i + 1))
    }
    for (const work of upstream) {
      expect(work.filters).toBeGreaterThanOrEqual(count)
      expect(work.filters).toBeLessThanOrEqual(count * 2)
      expect(work.consent).toBeGreaterThanOrEqual(count)
      expect(work.consent).toBeLessThanOrEqual(count * 2 + 1)
    }
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(phase === 'initial' ? 1 : 2)
    heldRead.resolve(null)
    await settle()
    for (const reply of replies) {
      reply.resolve()
      await settle()
    }
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(phase === 'fresh' ? 3 : 2)
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
    expect(state.keys.size).toBe(1)
    expect(state.metadataReads).toBe(1)
    expect(state.metadataWrites).toBe(0)
    expect(state.loads).toBe(1)
    expect(state.bytes).toBe((state.storage.get('orca:hosts') ?? '').length)
    expect(hashes).toHaveBeenCalledTimes(count)
    expect(signs).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
    expect(getDevicePushToken).toHaveBeenCalledOnce()
    for (const client of clients) {
      expect(
        client.sendRequest.mock.calls.filter(([method]) => method === 'notifications.registerPush')
      ).toHaveLength(1)
    }
    for (const interest of interests.filter((interest) => interest.retired)) {
      expect(interest.predicate).toHaveBeenCalledTimes(interest.calls)
    }
    expect(source.pushRoutePreparationSnapshotForTests()).toMatchObject({
      keyEntries: 0,
      keyTask: 0,
      creator: 0,
      builder: 0,
      latest: 0,
      builderCallables: 0,
      builderPayloads: 0,
      builderBodies: 0
    })
    state.callbacks.listener?.(
      changes ? { ...token, token: changes.toString(16).padStart(64, '0') } : token
    )
    await settle()
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(phase === 'fresh' ? 3 : 2)
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(state.loads).toBe(2)
    expect(hashes).toHaveBeenCalledTimes(count)
    expect(signs).toHaveBeenCalledTimes(4)
    expect(send).toHaveBeenCalledTimes(4)
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(phase === 'fresh' ? 3 : 2)
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
    expect(state.metadataReads).toBe(1)
    expect(state.metadataWrites).toBe(0)
    for (const client of clients) {
      expect(
        client.sendRequest.mock.calls.filter(([method]) => method === 'notifications.registerPush')
      ).toHaveLength(2)
    }
  }
)

it('completes Off during an issued key write, keeps the committed installation key and sends only after later opt-in', async () => {
  state.keys.clear()
  vi.resetModules()
  fixture.publisher = await import('./push-route-declaration')
  const registration = await import('./push-registration')
  const issued = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  vi.mocked(SecureStore.setItemAsync)
    .mockClear()
    .mockImplementationOnce(async (key, value) => {
      issued.resolve()
      await held.promise
      state.keys.set(key, value)
    })
  const client = {
    sendRequest: vi.fn(async (method: string, _params?: unknown) => ({
      id: 'write-race',
      ok: true as const,
      result:
        method === 'status.get'
          ? {
              capabilities: [
                registration.NOTIFICATIONS_REMOTE_PUSH_CAPABILITY,
                'notifications.push-route-key.v1'
              ]
            }
          : { registered: true, gatewayOrigin: 'https://push.onorca.dev', unregistered: true }
    }))
  }
  requests()
  fixture.stop = registration.startPushTokenSync()
  registration.attachPushRegistration('host-0', client)
  await settle()
  await issued.promise
  await registration.setRemotePushEnabled(false)
  await settle()
  expect(
    client.sendRequest.mock.calls.some(([method]) => method === 'notifications.unregisterPush')
  ).toBe(true)
  held.resolve()
  await settle()
  expect(
    client.sendRequest.mock.calls.filter(([method]) => method === 'notifications.registerPush')
  ).toEqual([])
  expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled()
  await registration.setRemotePushEnabled(true)
  await settle()
  const sent = client.sendRequest.mock.calls.find(
    ([method]) => method === 'notifications.registerPush'
  )
  if (!sent || !sent[1] || typeof sent[1] !== 'object' || !('routeKey' in sent[1])) {
    throw new Error('Missing keyed register')
  }
  expect(await fixture.publisher.mobilePushRouteKey(() => true).result).toEqual({
    status: 'ready',
    routeKey: sent[1].routeKey
  })
  expect(SecureStore.setItemAsync).toHaveBeenCalledOnce()
})

it('hands a retired first creator to the current waiter and recovers a committed lost-ack key without replacement', async () => {
  state.keys.clear()
  vi.resetModules()
  fixture.publisher = await import('./push-route-declaration')
  const fresh = Promise.withResolvers<string | null>()
  vi.mocked(SecureStore.getItemAsync)
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(() => fresh.promise)
  vi.mocked(SecureStore.setItemAsync).mockClear()
  let current = true
  const first = fixture.publisher.mobilePushRouteKey(() => current)
  await settle()
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  current = false
  first.release()
  const successor = fixture.publisher.mobilePushRouteKey(() => true)
  await expect(first.result).resolves.toEqual({ status: 'retired' })
  fresh.resolve(null)
  const key = await successor.result
  expect(key).toMatchObject({ status: 'ready', routeKey: expect.any(String) })
  expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
  expect(await fixture.publisher.mobilePushRouteKey(() => true).result).toEqual(key)

  state.keys.clear()
  vi.resetModules()
  fixture.publisher = await import('./push-route-declaration')
  const keychain = await import('../transport/pairing-keychain')
  const queued = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let prior: Promise<void> | undefined
  vi.mocked(SecureStore.getItemAsync)
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(async () => {
      prior = keychain.writePairingKeychainItem('r5-prior-write', 'owned')
      return null
    })
  vi.mocked(SecureStore.setItemAsync)
    .mockClear()
    .mockImplementationOnce(async (name, value) => {
      entered.resolve()
      await queued.promise
      state.keys.set(name, value)
    })
  const predicate = vi.fn(() => true)
  const waiting = fixture.publisher.mobilePushRouteKey(predicate)
  await settle()
  await entered.promise
  waiting.release()
  await expect(waiting.result).resolves.toEqual({ status: 'retired' })
  const calls = predicate.mock.calls.length
  const next = fixture.publisher.mobilePushRouteKey(() => true)
  expect(
    (await import('./push-route-declaration-build')).pushRoutePreparationSnapshotForTests()
  ).toMatchObject({ keyTask: 1, keyEntries: 1, creator: 0 })
  queued.resolve()
  await prior
  expect(await next.result).toMatchObject({ status: 'ready' })
  expect(predicate).toHaveBeenCalledTimes(calls)
  expect(
    vi
      .mocked(SecureStore.setItemAsync)
      .mock.calls.filter(([name]) => name === 'orca.push-route-key')
  ).toHaveLength(1)

  state.keys.clear()
  vi.resetModules()
  fixture.publisher = await import('./push-route-declaration')
  vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (name, value) => {
    state.keys.set(name, value)
    throw new Error('native committed but acknowledgement lost')
  })
  await expect(fixture.publisher.mobilePushRouteKey(() => true).result).resolves.toEqual({
    status: 'unavailable'
  })
  const persisted = state.keys.get('orca.push-route-key')
  if (!persisted) {
    throw new Error('Native write did not commit')
  }
  const recovered = Buffer.from(
    nacl.sign.keyPair.fromSecretKey(Buffer.from(persisted, 'base64')).publicKey
  ).toString('base64url')
  vi.mocked(SecureStore.setItemAsync).mockClear()
  await expect(fixture.publisher.mobilePushRouteKey(() => true).result).resolves.toEqual({
    status: 'ready',
    routeKey: recovered
  })
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
})

it('does not replace readable corrupt keys or thrown reads, and retries only on a genuine later caller', async () => {
  for (const failure of ['corrupt', 'read-error'] as const) {
    state.keys.clear()
    state.keys.set('orca.push-route-key', 'invalid')
    vi.resetModules()
    fixture.publisher = await import('./push-route-declaration')
    vi.mocked(SecureStore.setItemAsync).mockClear()
    if (failure === 'read-error') {
      vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('temporarily locked'))
    }
    const results = await Promise.all(
      Array.from({ length: 4 }, () => fixture.publisher.mobilePushRouteKey(() => true).result)
    )
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ status: 'unavailable' })))
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
    state.keys.clear()
    expect(await fixture.publisher.mobilePushRouteKey(() => true).result).toMatchObject({
      status: 'ready',
      routeKey: expect.any(String)
    })
    expect(SecureStore.setItemAsync).toHaveBeenCalledOnce()
  }
})

it('retains prior members and refuses all newcomers for the prior100 declaration for the exact102 then removed→101 catalog without truncation', async () => {
  hosts(100)
  const { bodies } = requests()
  await register()
  await settle()
  expect(bodies[0].hosts).toHaveLength(100)
  hosts(102)
  await (
    await import('../transport/host-removal-lifecycle')
  ).removeHostAndCloseClient('host-0', vi.fn())
  await settle()
  expect(JSON.parse(state.storage.get('orca:hosts') ?? '[]')).toHaveLength(101)
  expect(bodies.at(-1)?.hosts).toHaveLength(99)
  const retained = bodies.at(0)?.hosts
  const current = bodies.at(-1)?.hosts
  expect(current?.every((host) => retained?.includes(host))).toBe(true)
  expect(bodies.at(-1)?.version).toBeGreaterThan(bodies[0].version)
  const quiet = bodies.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(bodies).toHaveLength(quiet)
  await (await import('../transport/host-store')).removeHost('host-101')
  await settle()
  expect(bodies.at(-1)?.hosts).toHaveLength(100) // complete remaining batch now fits
})

it.each([10, 100, 101, 900])(
  'allocates a complete distinct %i catalog or refuses initial establishment without empty/floor write',
  async (count) => {
    hosts(count)
    const { bodies, operations } = requests()
    const fingerprint = await import('./push-host-fingerprint')
    const profiles = await (
      await import('../transport/host-metadata-store')
    ).readStoredHostProfilesForMutation()
    expect(
      new Set(profiles.map((profile) => fingerprint.deriveHostFingerprint(profile.publicKeyB64)))
        .size
    ).toBe(count)
    await register()
    expect(operations.filter((body) => body.action === 'read')).toHaveLength(1)
    if (count <= 100) {
      expect(bodies).toHaveLength(1)
      expect(bodies.at(0)?.hosts).toHaveLength(count)
      expect(state.storage.has('orca:push-route-version')).toBe(true)
    } else {
      expect(bodies).toEqual([])
      expect(state.storage.has('orca:push-route-version')).toBe(false)
    }
  }
)

it.each([10, 100])(
  'projects committed %i-row writes once, ignores metadata-only work, and reuses only current key spellings',
  async (count) => {
    hosts(count)
    const { send, operations, bodies } = requests()
    const fingerprint = await import('./push-host-fingerprint')
    const hashes = vi.spyOn(fingerprint, 'deriveHostFingerprint')
    const decodes = vi.spyOn(globalThis, 'atob')
    const signs = vi.spyOn(nacl.sign, 'detached')
    const storage = (await import('@react-native-async-storage/async-storage')).default
    const writes = vi.spyOn(storage, 'setItem')
    await register()
    expect(hashes).toHaveBeenCalledTimes(count)
    expect(decodes).toHaveBeenCalledTimes(count)
    expect(signs).toHaveBeenCalledTimes(2)
    const signedBytes = signs.mock.calls.map(([bytes]) => bytes.byteLength)
    expect(signedBytes).toEqual(
      operations.map((value) => Buffer.byteLength(pushRouteDeclarationContent(value)))
    )
    expect(send.mock.calls.map(([, init]) => Buffer.byteLength(String(init?.body)))).toEqual(
      operations.map((value) => Buffer.byteLength(JSON.stringify(value)))
    )
    const sourceBytes = state.bytes
    const loads = state.loads
    const store = await import('../transport/host-store')
    const rows = await (
      await import('../transport/host-metadata-store')
    ).readStoredHostProfilesForMutation()
    const first = rows.at(0)
    if (!first) {
      throw new Error('Missing paired profile')
    }
    for (let i = 0; i < 10; i++) {
      await store.updateLastConnected(first.id)
      await store.updateHostNameAndEndpoint(first.id, { personalName: `name-${i}` })
      await register()
    }
    expect(operations).toHaveLength(2)
    expect(hashes).toHaveBeenCalledTimes(count)
    expect(signs).toHaveBeenCalledTimes(2)
    const metadataWrites = writes.mock.calls.filter(([key]) => key === 'orca:hosts')
    expect(metadataWrites).toHaveLength(20)
    expect(state.loads).toBe(loads + 21) // separate initial row read plus twenty writer RMW reads
    expect(metadataWrites.every(([, value]) => JSON.parse(value).length === count)).toBe(true)
    expect(
      metadataWrites.reduce((bytes, [, value]) => bytes + Buffer.byteLength(value), 0)
    ).toBeGreaterThan(sourceBytes * 10)
    let visits = 0
    const observed = rows.map((profile) => ({
      ...profile,
      get publicKeyB64() {
        visits++
        return profile.publicKeyB64
      }
    }))
    fixture.publisher.refreshPushRoutes({ status: 'committed', revision: 1, profiles: observed })
    await settle()
    expect(visits).toBe(count)
    await register()
    expect(visits).toBe(count)
    const beforeProjectionLoads = state.loads
    // Same-key new id, restored order, and metadata changes do not cost another route request.
    const { mutateStoredHosts } = await import('../transport/host-list-mutation-queue')
    await mutateStoredHosts((rows) => rows.toReversed(), fixture.publisher.refreshPushRoutes)
    await settle()
    expect(send).toHaveBeenCalledTimes(2)
    expect(state.loads).toBe(beforeProjectionLoads + 1) // writer RMW only
    expect(state.bytes).toBeGreaterThan(sourceBytes)
    expect(state.loads).toBeGreaterThan(loads)
    const beforeRemoval = state.loads
    await store.removeHost(first.id)
    await settle()
    expect(state.loads).toBe(beforeRemoval + 1)
    expect(bodies.at(-1)?.hosts).toHaveLength(count - 1)
    expect(hashes).toHaveBeenCalledTimes(count)
    const changed = { ...first, id: 'same-key-new-id', deviceToken: 'fixture-token' }
    await store.savePairedHost(changed)
    await settle()
    expect(bodies.at(-1)?.hosts).toHaveLength(count)
    expect(hashes).toHaveBeenCalledTimes(count + 1) // removed projection entry was discarded
    expect(writes.mock.calls.filter(([key]) => key === 'orca:push-route-version')).toHaveLength(3)
    const beforeSameKey = send.mock.calls.length
    await store.savePairedHost({ ...changed, id: 'same-key-another-row' })
    await settle()
    expect(send).toHaveBeenCalledTimes(beforeSameKey)
    expect(hashes).toHaveBeenCalledTimes(count + 1)
  }
)

it('reads exact returning token q, bounds CAS reconstruction, and rejects arbitrary success without acknowledgement', async () => {
  const { bodies, send, operations, respond } = requests()
  await register()
  const first = bodies.at(0)
  if (!first) {
    throw new Error('Missing T1 proposal')
  }
  state.callbacks.listener?.({ ...token, token: 'cd'.repeat(32) })
  await settle()
  expect(bodies.at(-1)?.expectedVersion).toBeNull()
  state.callbacks.listener?.(token)
  await settle()
  expect(bodies.at(-1)?.expectedVersion).toBe(first.version)
  let conflicts = 0
  send.mockImplementation(async (_url, init) => {
    const value: unknown = JSON.parse(String(init?.body))
    if (
      typeof value === 'object' &&
      value !== null &&
      'action' in value &&
      value.action === 'replace'
    ) {
      conflicts++
      return new Response('{"error":"conflict"}', { status: 409 })
    }
    return respond(init)
  })
  const before = operations.filter((body) => body.action === 'read').length
  state.callbacks.appState?.('active')
  await settle()
  expect(conflicts).toBe(3)
  expect(operations.filter((body) => body.action === 'read')).toHaveLength(before + 3)
  const parked = send.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(send).toHaveBeenCalledTimes(parked)
  send.mockImplementation(async () => new Response('{}'))
  await register()
  await settle()
  const invalid = send.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(send).toHaveBeenCalledTimes(invalid)
  send.mockImplementation(async (_url, init) => respond(init))
  await register()
  await settle()
  expect(send).toHaveBeenCalledTimes(invalid + 2)
})

it('builds maximal token/read/replace bytes and never resets an exhausted saved floor', async () => {
  hosts(100)
  state.storage.set('orca:push-route-version', String(Number.MAX_SAFE_INTEGER - 2))
  const { bodies, operations, send } = requests()
  await register()
  state.callbacks.listener?.({ ...token, token: 'ab'.repeat(2048) })
  await settle()
  state.callbacks.appState?.('active')
  await settle()
  const read = operations.find((value) => value.action === 'read' && value.token.length === 4096)
  const replace = bodies.at(-1)
  expect(Buffer.byteLength(JSON.stringify(read))).toBe(4336)
  // First short-token cycle consumed one version; the long-token cycle reaches MAX_SAFE.
  expect(replace?.version).toBe(Number.MAX_SAFE_INTEGER)
  expect(replace?.hosts).toHaveLength(100)
  expect(Buffer.byteLength(JSON.stringify(replace))).toBe(6299) // authenticated absence signs null
  const before = send.mock.calls.length
  state.callbacks.appState?.('active')
  await settle()
  expect(send).toHaveBeenCalledTimes(before)
  expect(state.storage.get('orca:push-route-version')).toBe(String(Number.MAX_SAFE_INTEGER))
})
