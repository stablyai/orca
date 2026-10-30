import {
  registration,
  native,
  consent,
  ports,
  T2,
  lifetime,
  detach,
  drain,
  attach
} from './push-native-consent-lifetime.test-fixture'
import { pushOwnerRpcPort as client } from './push-owner-native-ports.test-fixture'
import { expect, it, vi } from 'vitest'
import { ownerCleanup } from '../../../cloud/apps/push/src/push-owner-integration.test-fixture'
import { AppState, Platform } from 'react-native'
import type { ConnectionState } from '../transport/types'
import type { HostClientStoreEntry } from '../transport/host-entry-opener'
import {
  readPushNotificationsPreference,
  savePushNotificationsEnabled
} from '../storage/preferences'

it.each([
  { H: 4, M: 10, R: 10 },
  { H: 40, M: 100, R: 100 }
])(
  'bounds actual H$H/M$M/R$R native interests over the real Expo wrapper and retires own results before source',
  async ({ H, M, R }) => {
    ports.nativeHold = Promise.withResolvers<string>()
    const source = await import('./push-token')
    const wrappers = vi.spyOn(source, 'getDevicePushToken')
    const expo = vi.spyOn(await import('expo-notifications'), 'getDevicePushTokenAsync')
    const prepare = native.prepareNativePushToken
    const outcomes: {
      retired: boolean
      calls: number
      predicate: ReturnType<typeof vi.fn<() => boolean>>
    }[] = []
    vi.spyOn(native, 'prepareNativePushToken').mockImplementation((current, token) => {
      const predicate = vi.fn(current)
      const handle = prepare(predicate, token)
      const entry = { retired: false, calls: 0, predicate }
      outcomes.push(entry)
      void handle.result.then((result) => {
        if (result.status === 'retired') {
          entry.retired = true
          entry.calls = predicate.mock.calls.length
        }
      })
      return handle
    })
    lifetime.stop = registration.startPushTokenSync()
    const clients = attach(H)
    await drain()
    expect(native.pushNativeSnapshotForTests()).toMatchObject({
      physical: 1,
      assignment: 1,
      entries: H,
      timers: H
    })
    for (let i = 0; i < M; i++) {
      ports.foreground?.('active')
      await drain()
      expect(native.pushNativeSnapshotForTests().entries).toBeLessThanOrEqual(H)
      await vi.advanceTimersByTimeAsync(2000)
      expect(native.pushNativeSnapshotForTests().entries).toBe(0)
    }
    for (let i = 0; i < R; i++) {
      lifetime.stop()
      expect(native.pushNativeSnapshotForTests()).toMatchObject({
        physical: 1,
        assignment: 0,
        entries: 0,
        callables: 0
      })
      lifetime.stop = registration.startPushTokenSync()
      await drain()
      expect(native.pushNativeSnapshotForTests().entries).toBeLessThanOrEqual(H)
    }
    expect(wrappers).toHaveBeenCalledOnce()
    expect(expo).toHaveBeenCalledOnce()
    expect(ports.nativeCalls).toBe(1)
    expect(ports.listenerRemovals).toBe(R)
    expect(ports.channelCalls).toEqual([])
    expect(ports.keys.size).toBe(0)
    for (const connection of clients) {
      expect(
        connection.sendRequest.mock.calls.filter(
          ([method]) => method === 'notifications.registerPush'
        )
      ).toHaveLength(0)
    }
    lifetime.stop()
    await drain()
    expect(outcomes.some((outcome) => outcome.retired)).toBe(true)
    expect(native.pushNativeSnapshotForTests()).toMatchObject({
      entries: 0,
      timers: 0,
      assignment: 0,
      callables: 0
    })
    lifetime.stop = registration.startPushTokenSync()
    await drain()
    ports.nativeHold.resolve(ports.native.token)
    await drain()
    for (const connection of clients) {
      expect(
        connection.sendRequest.mock.calls.filter(
          ([method]) => method === 'notifications.registerPush'
        )
      ).toHaveLength(1)
    }
    for (const outcome of outcomes.filter((entry) => entry.retired)) {
      expect(outcome.predicate).toHaveBeenCalledTimes(outcome.calls)
    }
  }
)

it('gives a staggered admission its own full two seconds and returns unavailable immediately without physical work', async () => {
  await expect(
    native.prepareNativePushToken(
      () => true,
      () => null
    ).result
  ).resolves.toEqual({ status: 'unavailable' })
  ports.nativeHold = Promise.withResolvers<string>()
  lifetime.stop = registration.startPushTokenSync()
  attach(1)
  await drain()
  await vi.advanceTimersByTimeAsync(1500)
  const second = client()
  detach.push(registration.attachPushRegistration('later', second))
  await drain()
  await vi.advanceTimersByTimeAsync(500)
  expect(native.pushNativeSnapshotForTests().entries).toBe(1)
  await vi.advanceTimersByTimeAsync(1499)
  expect(native.pushNativeSnapshotForTests().entries).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(native.pushNativeSnapshotForTests().entries).toBe(0)
})

it.each(['token', 'null', 'error'] as const)(
  'keeps listener T2 across roots/local persistence when old native returns %s',
  async (result) => {
    ports.nativeHold = Promise.withResolvers<string>()
    lifetime.stop = registration.startPushTokenSync()
    const [connection] = attach(1)
    await drain()
    lifetime.stop()
    lifetime.stop = registration.startPushTokenSync()
    await drain()
    ports.consentHold = { mode: 'reply', gate: Promise.withResolvers<void>() }
    ports.foreground?.('active')
    await drain()
    const saved = registration.setNotificationDeliveryPreferences({
      onlyWhenDesktopAway: false,
      sound: false,
      suppressWhileViewing: true
    })
    ports.native = T2
    ports.listener?.(T2)
    await saved
    if (result === 'error') {
      ports.nativeHold.reject(new Error('finite native failure'))
    } else {
      ports.nativeHold.resolve(result === 'token' ? 'a'.repeat(64) : '')
    }
    await drain()
    expect(
      connection?.sendRequest.mock.calls.filter(
        ([method]) => method === 'notifications.registerPush'
      )
    ).toHaveLength(0)
    ports.consentHold.gate.resolve()
    ports.consentHold = undefined
    await drain()
    expect(connection?.sendRequest).toHaveBeenCalledWith(
      'notifications.registerPush',
      { ...T2, filter: { onlyWhenDesktopAway: false, sound: false } },
      { failWhenDisconnected: true, timeoutMs: 5000 }
    )
    expect(ports.nativeCalls).toBe(1)
  }
)

it('lets fresh host consent join a retired pending native phase without starting or reviving an old assignment', async () => {
  ports.nativeHold = Promise.withResolvers<string>()
  lifetime.stop = registration.startPushTokenSync()
  await drain()
  ports.storage.set('orca:pushServiceNotificationsEnabled', 'false')
  const off = client()
  detach.push(registration.attachPushRegistration('off-observation', off))
  await drain()
  expect(native.pushNativeSnapshotForTests()).toMatchObject({ physical: 1, assignment: 0 })
  expect(
    off.sendRequest.mock.calls.filter(([method]) => method === 'notifications.unregisterPush')
  ).toHaveLength(1)
  ports.storage.set('orca:pushServiceNotificationsEnabled', 'true')
  const current = client()
  detach.push(registration.attachPushRegistration('fresh-observation', current))
  await drain()
  expect(native.pushNativeSnapshotForTests()).toMatchObject({
    physical: 1,
    assignment: 1,
    entries: 1
  })
  expect(ports.nativeCalls).toBe(1)
  ports.nativeHold.resolve(ports.native.token)
  await drain()
  expect(current.sendRequest).toHaveBeenCalledWith(
    'notifications.registerPush',
    expect.objectContaining({ token: ports.native.token }),
    { failWhenDisconnected: true, timeoutMs: 5000 }
  )
  expect(
    current.sendRequest.mock.calls.filter(([method]) => method === 'notifications.registerPush')
  ).toHaveLength(1)
  expect(ports.nativeCalls).toBe(1)
})

it.each(['null', 'error'] as const)(
  'ends finite native %s without self-retry and retries on a genuine foreground demand',
  async (outcome) => {
    ports.nativeHold = Promise.withResolvers<string>()
    lifetime.stop = registration.startPushTokenSync()
    const [connection] = attach(1)
    await drain()
    if (outcome === 'error') {
      ports.nativeHold.reject(new Error('finite native error'))
    } else {
      ports.nativeHold.resolve('')
    }
    await drain()
    expect(native.pushNativeSnapshotForTests()).toMatchObject({
      physical: 0,
      assignment: 0,
      entries: 0
    })
    expect(ports.nativeCalls).toBe(1)
    await drain()
    expect(ports.nativeCalls).toBe(1)
    ports.nativeHold = undefined
    ports.foreground?.('active')
    await drain()
    expect(ports.nativeCalls).toBe(2)
    expect(
      connection?.sendRequest.mock.calls.filter(
        ([method]) => method === 'notifications.registerPush'
      )
    ).toHaveLength(1)
    await expect(
      native.prepareNativePushToken(
        () => true,
        () => T2
      ).result
    ).resolves.toEqual({ status: 'ready', token: T2 })
  }
)

it.each(['complete', 'fail'] as const)(
  'counts both real Android channel operations and retirement before device invocation: %s',
  async (outcome) => {
    Object.assign(Platform, { OS: 'android' })
    ports.channelHold = Promise.withResolvers<void>()
    lifetime.stop = registration.startPushTokenSync()
    attach(1)
    await drain()
    expect(ports.channelCalls).toEqual(['orca-desktop-silent'])
    lifetime.stop()
    if (outcome === 'fail') {
      ports.channelHold.reject(new Error('channel unavailable'))
    } else {
      ports.channelHold.resolve()
    }
    await drain()
    expect(ports.channelCalls).toEqual(
      outcome === 'complete' ? ['orca-desktop-silent', 'orca-desktop'] : ['orca-desktop-silent']
    )
    expect(ports.nativeCalls).toBe(0)
  }
)

it.each([
  { H: 4, M: 10, R: 10 },
  { H: 40, M: 100, R: 100 }
])(
  'bounds H$H/M$M/R$R consent requests at the actual native disk queue head and releases all current cells',
  async ({ H, M, R }) => {
    ports.consentHold = { mode: 'disk', gate: Promise.withResolvers<void>() }
    lifetime.stop = registration.startPushTokenSync()
    attach(H)
    await drain()
    for (let i = 0; i < M; i++) {
      ports.foreground?.('active')
      await drain()
    }
    for (let i = 0; i < R; i++) {
      lifetime.stop()
      lifetime.stop = registration.startPushTokenSync()
      await drain()
      expect(consent.pushConsentSnapshotForTests()).toMatchObject({ physical: 1 })
      expect(consent.pushConsentSnapshotForTests().queued).toBeLessThanOrEqual(H + 1)
      expect(consent.pushConsentSnapshotForTests().hosts).toBeLessThanOrEqual(H)
      expect(consent.pushConsentSnapshotForTests().root).toBeLessThanOrEqual(1)
    }
    const saving = savePushNotificationsEnabled(false)
    let saved = false
    void saving.then(() => {
      saved = true
    })
    await drain()
    expect(saved).toBe(false)
    lifetime.stop()
    for (const release of detach.splice(0)) {
      release()
    }
    await drain()
    expect(consent.pushConsentSnapshotForTests()).toEqual({
      physical: 1,
      selected: 0,
      queued: 0,
      root: 0,
      hosts: 0,
      callables: 0
    })
    expect(ports.consentCalls).toBe(0)
    expect(
      ports.nativeGets.filter((key) => key === 'orca:pushServiceNotificationsEnabled')
    ).toHaveLength(1)
    ports.consentHold.gate.resolve()
    ports.consentHold = undefined
    await saving
    await drain()
    expect(saved).toBe(true)
    expect(ports.consentCalls).toBe(1)
  }
)

it('preserves distinct finite errors, fair root latest demand and direct-reader independence after native completion', async () => {
  const gate = Promise.withResolvers<void>()
  ports.consentHold = { mode: 'reply', gate }
  const oldCurrent = vi.fn(() => true)
  const old = consent.preparePushConsent(oldCurrent)
  await drain()
  old.release()
  await expect(old.result).resolves.toEqual({ status: 'retired' })
  const oldCalls = oldCurrent.mock.calls.length
  const order: string[] = []
  const host = consent.preparePushConsent(() => true)
  let releaseRoot = () => {}
  for (let i = 0; i < 100; i++) {
    releaseRoot = consent.refreshPushConsent(
      () => true,
      () => {
        order.push('root')
      }
    )
  }
  const hostResult = host.result.then((result) => {
    order.push('host')
    return result
  })
  // Only JS reply delivery is held; direct disk work remains independent.
  await savePushNotificationsEnabled(false)
  ports.consentHold = undefined
  await expect(readPushNotificationsPreference()).resolves.toEqual({ value: false, loaded: true })
  expect(ports.consentCalls).toBe(2)
  ports.consentResults.push(new Error('own finite host read'), 'true')
  gate.resolve()
  await drain()
  await expect(hostResult).resolves.toEqual({
    status: 'observed',
    preference: { value: null, loaded: false }
  })
  expect(order).toEqual(['host', 'root'])
  expect(ports.consentCalls).toBe(4)
  await expect(consent.preparePushConsent(() => true).result).resolves.toEqual({
    status: 'observed',
    preference: { value: false, loaded: true }
  })
  expect(ports.consentCalls).toBe(5)
  releaseRoot()
  host.release()
  expect(oldCurrent).toHaveBeenCalledTimes(oldCalls)
})

it('retires consent before removal awaits and bounds genuine logical-client reconnects without completing another pairing', async () => {
  const { HostClientOpenRegistry } = await import('../transport/host-client-open-registry')
  const { HostOpenRetryScheduler } = await import('../transport/host-open-retry-scheduler')
  const { openHostClientEntry } = await import('../transport/host-entry-opener')
  const { savePairedHost } = await import('../transport/host-store')
  const stateListeners = new Set<(state: ConnectionState) => void>()
  let state: ConnectionState = 'connected'
  const physical = {
    ...client(),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    notifyForeground: () => {},
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: (listener: (next: ConnectionState) => void) => {
      stateListeners.add(listener)
      return () => {
        stateListeners.delete(listener)
      }
    },
    close: () => {
      stateListeners.clear()
    }
  }
  ports.session = physical
  const host = {
    id: 'reconnected',
    name: 'Host',
    endpoint: 'ws://127.0.0.1:1',
    deviceToken: 'generated-test-device',
    publicKeyB64: Buffer.alloc(32, 3).toString('base64'),
    lastConnected: 0
  }
  await savePairedHost(host)
  lifetime.stop = registration.startPushTokenSync()
  await drain()
  Object.assign(Platform, { OS: 'web' })
  const store = new Map<string, HostClientStoreEntry>()
  const retryScheduler = new HostOpenRetryScheduler({ canRetry: () => false, open: () => {} })
  const entry = await openHostClientEntry(
    {
      store,
      pendingOpens: new HostClientOpenRegistry(),
      pendingAcquisitions: new Map([['reconnected', 1]]),
      primedHosts: new Map([['reconnected', host]]),
      retryScheduler,
      notifyHostState: () => {},
      notifyAllHosts: () => {}
    },
    'reconnected'
  )
  if (!entry) {
    throw new Error('Real logical opener did not publish its current entry')
  }
  const { removeHostAndCloseClient } = await import('../transport/host-removal-lifecycle')
  const removals: Promise<void>[] = []
  const forget = () => {
    if (store.delete(host.id)) {
      entry.unsubState()
      entry.unsubConnectionPath()
      entry.client.close()
    }
  }
  let primary: { failed: true; error: unknown } | undefined
  try {
    await drain()
    ports.consentHold = { mode: 'disk', gate: Promise.withResolvers<void>() }
    ports.foreground?.('active')
    await drain()
    for (let i = 0; i < 100; i++) {
      removals.push(removeHostAndCloseClient(host.id, forget))
      state = 'disconnected'
      for (const listener of stateListeners) {
        listener(state)
      }
      state = 'connected'
      for (const listener of stateListeners) {
        listener(state)
      }
      await drain()
      expect(store.get(host.id)?.client).toBe(entry.client)
      expect(JSON.parse(ports.storage.get('orca:hosts') ?? '[]')).toHaveLength(1)
      expect(consent.pushConsentSnapshotForTests().physical).toBe(1)
      expect(consent.pushConsentSnapshotForTests().hosts).toBeLessThanOrEqual(1)
      expect(consent.pushConsentSnapshotForTests().queued).toBeLessThanOrEqual(2)
    }
    entry.unsubState()
    lifetime.stop()
    await drain()
    expect(consent.pushConsentSnapshotForTests()).toMatchObject({
      physical: 1,
      selected: 0,
      queued: 0,
      hosts: 0,
      root: 0,
      callables: 0
    })
  } catch (error) {
    primary = { failed: true, error }
  }
  const cleanup = ownerCleanup(primary)
  for (const close of [
    entry.unsubState,
    entry.unsubConnectionPath,
    () => entry.client.close(),
    () => retryScheduler.cancelAll()
  ]) {
    await cleanup.run(close)
  }
  await cleanup.run(() => ports.consentHold?.gate.resolve())
  ports.consentHold = undefined
  await cleanup.run(drain)
  for (const removal of removals) {
    await cleanup.run(() => removal)
  }
  await cleanup.run(() => expect(JSON.parse(ports.storage.get('orca:hosts') ?? '[]')).toEqual([]))
  await cleanup.run(async () =>
    (await import('../transport/persisted-connection-log-store')).connectionLogStore.flush()
  )
  ports.session = undefined
  cleanup.finish()
})

it.each([10, 100])(
  'keeps a finite root failure distinct from %i completing host observations with known T2, without self-work',
  async (count) => {
    const storage = (await import('@react-native-async-storage/async-storage')).default
    const getItem = vi.spyOn(storage, 'getItem')
    const filters = vi.spyOn(
      await import('./notification-delivery-preferences'),
      'loadNotificationDeliveryPreferences'
    )
    ports.consentResults.push(new Error('root read failed'))
    lifetime.stop = registration.startPushTokenSync()
    await drain()
    expect(ports.nativeCalls).toBe(0)
    ports.consentResults.push(new Error('listener root read failed'))
    ports.native = T2
    ports.listener?.(T2)
    await drain()
    const first = client(true)
    detach.push(registration.attachPushRegistration('root-error', first))
    await drain()
    expect(first.sendRequest).toHaveBeenCalledWith(
      'notifications.registerPush',
      expect.objectContaining({ token: T2.token, routeKey: expect.any(String) }),
      { failWhenDisconnected: true, timeoutMs: 5000 }
    )
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://push.onorca.dev/v1/routes',
      expect.objectContaining({ body: expect.stringContaining('"action":"read"') })
    )
    const reads = ports.consentCalls
    await drain()
    expect(ports.consentCalls).toBe(reads)
    for (let i = 0; i < count; i++) {
      ports.consentResults.push(i % 2 ? 'true' : new Error('own host failure'))
      const next = client()
      const release = registration.attachPushRegistration('alternating', next)
      await drain()
      expect(
        next.sendRequest.mock.calls.filter(
          ([method]) =>
            method === (i % 2 ? 'notifications.registerPush' : 'notifications.unregisterPush')
        )
      ).toHaveLength(1)
      const completed = ports.consentCalls
      await drain()
      expect(ports.consentCalls).toBe(completed)
      release()
    }
    expect(ports.nativeCalls).toBe(0)
    expect(ports.consentCalls).toBe(count + 3)
    expect(
      ports.nativeGets.filter((key) => key === 'orca:pushServiceNotificationsEnabled')
    ).toHaveLength(count + 3)
    expect(
      getItem.mock.calls.filter(([key]) => key === 'orca:pushServiceNotificationsEnabled')
    ).toHaveLength(count + 3)
    expect(filters).toHaveBeenCalledTimes(1 + count / 2)
  }
)

it.each(['false', 'error'] as const)(
  'keeps pending-branch true and normal second-read %s observations distinct',
  async (second) => {
    lifetime.stop = registration.startPushTokenSync()
    await drain()
    ports.storage.set(
      'orca:remotePushHostRegistrations',
      JSON.stringify({ registeredHostIds: ['pending'], pendingUnregisterHostIds: ['pending'] })
    )
    // Reconstruct the record cache from actual saved state before admitting the host.
    registration.resetPushRegistrationForTests()
    lifetime.stop = registration.startPushTokenSync()
    await drain()
    ports.consentResults.push(
      'true',
      second === 'false' ? 'false' : new Error('second read failed')
    )
    const connection = client()
    detach.push(registration.attachPushRegistration('pending', connection))
    await drain()
    expect(
      connection.sendRequest.mock.calls.filter(
        ([method]) => method === 'notifications.unregisterPush'
      )
    ).toHaveLength(1)
    expect(
      connection.sendRequest.mock.calls.filter(
        ([method]) => method === 'notifications.registerPush'
      )
    ).toHaveLength(0)
    expect(ports.consentResults).toEqual([])
  }
)
