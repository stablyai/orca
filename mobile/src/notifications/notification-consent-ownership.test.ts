vi.mock('../transport/pairing-keychain', () => {
  const items = new Map<string, string>()
  return {
    readPairingKeychainItem: async (key: string) => items.get(key) ?? null,
    writePairingKeychainItemIfCurrent: async (
      key: string,
      value: string,
      isCurrent: () => boolean
    ) => {
      if (!isCurrent()) {
        return 'retired' as const
      }
      items.set(key, value)
      return 'written' as const
    },
    writePairingKeychainItem: async (key: string, value: string) => {
      items.set(key, value)
    },
    deletePairingKeychainItem: async (key: string) => {
      items.delete(key)
    }
  }
})
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import NotificationsScreen from '../../app/notifications'
import MobileOnboardingScreen from '../../app/mobile-onboarding'
import { shouldPresentNotificationOptIn } from './notification-opt-in-gate'
import {
  attachPushRegistration,
  NOTIFICATIONS_REMOTE_PUSH_CAPABILITY,
  resetPushRegistrationForTests,
  setRemotePushEnabled,
  setNotificationDeliveryPreferences,
  startPushTokenSync
} from './push-registration'
import { getDevicePushToken, type MobilePushToken } from './push-token'
import type { RpcResponse } from '../transport/types'
import { findByHostType } from '../test-support/react-test-renderer-host-nodes'

const mocks = vi.hoisted(
  (): {
    storage: Map<string, string>
    replace: ReturnType<typeof vi.fn>
    listener?: (token: MobilePushToken) => void
  } => ({ storage: new Map(), replace: vi.fn() })
)
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => mocks.storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      mocks.storage.set(key, value)
    })
  }
}))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) },
  AccessibilityInfo: {
    addEventListener: () => ({ remove: vi.fn() }),
    isReduceMotionEnabled: async () => false
  },
  Animated: { Value: class {}, View: 'View', multiply: () => 0 },
  BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
  Switch: 'Switch',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Alert: { alert: vi.fn() },
  Linking: { openSettings: vi.fn() },
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))
vi.mock('expo-notifications', () => ({ scheduleNotificationAsync: vi.fn() }))
vi.mock('expo-router', () => ({
  useFocusEffect: vi.fn(),
  useLocalSearchParams: () => ({ hostId: 'host', steps: 'notifications' }),
  useRouter: () => ({ replace: mocks.replace })
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'View',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon' }))
vi.mock('../components/OrcaLogo', () => ({ OrcaLogo: 'Logo' }))
vi.mock('../onboarding/MobileOnboardingPage', () => ({ MobileOnboardingPage: 'Page' }))
vi.mock('../transport/use-all-host-clients', () => ({ useAllHostClients: () => [] }))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: async () => [] }))
vi.mock('./NotificationDeliverySection', () => ({ NotificationDeliverySection: 'Delivery' }))
vi.mock('./use-remote-push-capable-hosts', () => ({ useRemotePushCapableHosts: () => [] }))
vi.mock('./notification-permissions', () => ({
  ensureNotificationPermissions: async () => true,
  getNotificationPermissionState: async () => ({
    granted: true,
    status: 'granted',
    canAskAgain: true,
    authorizationReflectsUserChoice: true
  })
}))
vi.mock('./mobile-notifications', () => ({
  ensureNotificationPermissions: async () => true,
  getNotificationPermissionState: async () => ({
    granted: true,
    status: 'granted',
    canAskAgain: true,
    authorizationReflectsUserChoice: true
  })
}))
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: async () => {}
}))
vi.mock('./push-token', () => ({
  getDevicePushToken: vi.fn(),
  addPushTokenListener: (listener: (token: MobilePushToken) => void) => {
    mocks.listener = listener
    return () => {
      if (mocks.listener === listener) {
        mocks.listener = undefined
      }
    }
  }
}))

const token = {
  platform: 'ios' as const,
  token: 'a'.repeat(64),
  apnsEnvironment: 'sandbox' as const
}
let renderer: ReactTestRenderer | undefined
let stopSync: () => void
const records = () => JSON.parse(mocks.storage.get('orca:remotePushHostRegistrations') ?? '{}')
const drain = () => vi.advanceTimersByTimeAsync(0)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function connection() {
  return {
    sendRequest: vi.fn(async (method: string, _params?: unknown): Promise<RpcResponse> => ({
      id: 'consent-test',
      ok: true,
      result:
        method === 'status.get'
          ? { capabilities: [NOTIFICATIONS_REMOTE_PUSH_CAPABILITY] }
          : { registered: true, unregistered: true }
    }))
  }
}
async function connectedHost() {
  const client = connection()
  attachPushRegistration('host', client)
  await drain()
  client.sendRequest.mockClear()
  return client
}
function layoutOnboarding() {
  renderer!.root
    .findAll((node) => node.props.onLayout !== undefined)[0]
    ?.props.onLayout({ nativeEvent: { layout: { width: 390 } } })
}
async function choose(entry: string) {
  await act(async () => {
    renderer = create(
      createElement(entry === 'settings' ? NotificationsScreen : MobileOnboardingScreen)
    )
  })
  await act(async () => layoutOnboarding())
  await act(async () => {
    if (entry === 'settings') {
      findByHostType(renderer!.root, 'Switch').props.onValueChange(true)
    } else {
      findByHostType(renderer!.root, 'Page').props.onNotificationChoice('enable')
    }
  })
}
function expectChoiceComplete(entry: string) {
  expect(mocks.storage.get('orca:pushServiceNotificationsEnabled')).toBe('true')
  if (entry === 'settings') {
    expect(findByHostType(renderer!.root, 'Switch').props).toMatchObject({
      value: true,
      disabled: false
    })
  }
  if (entry === 'onboarding') {
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('/h/host')
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.storage.clear()
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => mocks.storage.get(key) ?? null)
  vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
    mocks.storage.set(key, value)
  })
  resetPushRegistrationForTests()
  vi.mocked(getDevicePushToken).mockResolvedValue(token)
  stopSync = startPushTokenSync()
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  stopSync()
  resetPushRegistrationForTests()
  vi.useRealTimers()
})

it.each(['true', 'false'])(
  'requires consent before registering a legacy %s user',
  async (legacy) => {
    mocks.storage.set('orca:pushNotificationsEnabled', legacy)
    const client = await connectedHost()
    await expect(shouldPresentNotificationOptIn()).resolves.toBe(true)
    await drain()
    expect(getDevicePushToken).not.toHaveBeenCalled()
    expect(client.sendRequest).not.toHaveBeenCalled()
    await choose('onboarding')
    await drain()
    await expect(shouldPresentNotificationOptIn()).resolves.toBe(false)
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'notifications.registerPush'
    ])
  }
)

it('remembers Not now without registering and does not ask again', async () => {
  mocks.storage.set('orca:pushNotificationsEnabled', 'true')
  const client = await connectedHost()
  await act(async () => {
    renderer = create(createElement(MobileOnboardingScreen))
  })
  await act(async () => layoutOnboarding())
  await act(async () => {
    findByHostType(renderer!.root, 'Page').props.onNotificationChoice('skip')
  })
  await drain()
  await expect(shouldPresentNotificationOptIn()).resolves.toBe(false)
  expect(mocks.storage.get('orca:pushServiceNotificationsEnabled')).toBe('false')
  expect(getDevicePushToken).not.toHaveBeenCalled()
  expect(
    client.sendRequest.mock.calls.some(([method]) => method === 'notifications.registerPush')
  ).toBe(false)
})

it.each(['settings', 'onboarding'])(
  '%s schedules exactly one registration with token sync running',
  async (entry) => {
    const client = await connectedHost()
    await choose(entry)
    await drain()
    expectChoiceComplete(entry)
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'notifications.registerPush'
    ])
    expect(records().registeredHostIds).toEqual(['host'])
  }
)

it.each(['settings', 'onboarding'])(
  '%s finishes local consent while native token acquisition is pending',
  async (entry) => {
    const client = await connectedHost()
    const pending = deferred<typeof token>()
    vi.mocked(getDevicePushToken).mockReturnValue(pending.promise)
    await choose(entry)
    await drain()
    expectChoiceComplete(entry)
    expect(getDevicePushToken).toHaveBeenCalledOnce()
    expect(client.sendRequest).not.toHaveBeenCalled()
    pending.resolve(token)
    await drain()
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'notifications.registerPush'
    ])
  }
)

it.each(['settings', 'onboarding'])(
  '%s finishes local consent while registration RPC is pending',
  async (entry) => {
    const client = await connectedHost()
    const pending = deferred<RpcResponse>()
    client.sendRequest.mockImplementationOnce(() => pending.promise)
    await choose(entry)
    await drain()
    expectChoiceComplete(entry)
    expect(client.sendRequest).toHaveBeenCalledOnce()
    expect(records().registeredHostIds).toEqual([])
    pending.resolve({ id: 'consent-test', ok: true, result: { registered: true } })
    await drain()
    expect(records().registeredHostIds).toEqual(['host'])
    expect(client.sendRequest).toHaveBeenCalledOnce()
  }
)

it.each(['current', 'replacement', 'stopped'] as const)(
  'waits for durable local records with %s root and schedules one unregister without waiting for its RPC',
  async (lifetime) => {
    const client = await connectedHost()
    await setRemotePushEnabled(true)
    await drain()
    client.sendRequest.mockClear()
    const write = deferred<void>()
    vi.mocked(AsyncStorage.setItem)
      .mockImplementationOnce(async (key, value) => {
        mocks.storage.set(key, value)
      })
      .mockImplementationOnce(async (key, value) => {
        await write.promise
        mocks.storage.set(key, value)
      })
    const rpc = deferred<RpcResponse>()
    client.sendRequest.mockImplementationOnce(() => rpc.promise)
    const completed = vi.fn()
    const disable = setRemotePushEnabled(false).then(completed)
    await drain()
    // Cached records are already mutated; dirty work and a replacement root still cannot dispatch.
    mocks.listener?.({ ...token, token: 'b'.repeat(64) })
    attachPushRegistration('host', client)
    if (lifetime !== 'current') {
      stopSync()
      if (lifetime === 'replacement') {
        stopSync = startPushTokenSync()
      }
    }
    mocks.listener?.({ ...token, token: 'c'.repeat(64) })
    await drain()
    expect(completed).not.toHaveBeenCalled()
    expect(client.sendRequest).not.toHaveBeenCalled()
    write.resolve()
    await disable
    await drain()
    expect(completed).toHaveBeenCalledOnce()
    expect(records().pendingUnregisterHostIds).toEqual(['host'])
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'notifications.unregisterPush'
    ])
    rpc.resolve({ id: 'consent-test', ok: true, result: {} })
    await drain()
    expect(records()).toEqual({ registeredHostIds: [], pendingUnregisterHostIds: [] })
    expect(client.sendRequest).toHaveBeenCalledOnce()
  }
)

it('exposes a failed consent write without scheduling or changing durable consent', async () => {
  const client = await connectedHost()
  vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('consent write failed'))
  await expect(setRemotePushEnabled(true)).rejects.toThrow('consent write failed')
  await drain()
  expect(mocks.storage.has('orca:pushServiceNotificationsEnabled')).toBe(false)
  expect(client.sendRequest).not.toHaveBeenCalled()
})

it('exposes a failed records write and still schedules exactly one cleanup', async () => {
  const client = await connectedHost()
  await setRemotePushEnabled(true)
  await drain()
  client.sendRequest.mockClear()
  vi.mocked(AsyncStorage.setItem)
    .mockImplementationOnce(async (key, value) => {
      mocks.storage.set(key, value)
    })
    .mockRejectedValueOnce(new Error('records write failed'))
  await expect(setRemotePushEnabled(false)).rejects.toThrow('records write failed')
  await drain()
  expect(mocks.storage.get('orca:pushServiceNotificationsEnabled')).toBe('false')
  expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
    'notifications.unregisterPush'
  ])
  expect(records()).toEqual({ registeredHostIds: [], pendingUnregisterHostIds: [] })
})

it.each(
  ['consent-first', 'filter-first'].flatMap((order) =>
    ['none', 'consent', 'records', 'filter'].map((failure) => ({ order, failure }))
  )
)(
  'finishes each overlapping local operation independently and dispatches only after the last save: $order/$failure',
  async ({ order, failure }) => {
    const client = await connectedHost()
    await setRemotePushEnabled(true)
    await drain()
    client.sendRequest.mockClear()
    const consent = deferred<void>()
    const filter = deferred<void>()
    const rpc = deferred<RpcResponse>()
    const save = vi.mocked(AsyncStorage.setItem).getMockImplementation()
    if (!save) {
      throw new Error('Missing faithful storage port')
    }
    let failed = false
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
      if (key === 'orca:pushServiceNotificationsEnabled') {
        await consent.promise
      } else if (key === 'orca:notificationDeliveryPreferences') {
        await filter.promise
      }
      if (
        !failed &&
        key ===
          (failure === 'consent'
            ? 'orca:pushServiceNotificationsEnabled'
            : failure === 'records'
              ? 'orca:remotePushHostRegistrations'
              : failure === 'filter'
                ? 'orca:notificationDeliveryPreferences'
                : undefined)
      ) {
        failed = true
        throw new Error(`${failure} failed`)
      }
      await save(key, value)
    })
    const errors: string[] = []
    const capture = (error: unknown) => {
      if (!(error instanceof Error)) {
        throw error
      }
      errors.push(error.message)
    }
    const consentDone = vi.fn()
    const filterDone = vi.fn()
    const disable = setRemotePushEnabled(false).catch(capture).then(consentDone)
    const preferences = setNotificationDeliveryPreferences({
      onlyWhenDesktopAway: false,
      sound: false,
      suppressWhileViewing: true
    })
      .catch(capture)
      .then(filterDone)
    await drain()
    client.sendRequest.mockImplementationOnce(() => rpc.promise)
    if (order === 'consent-first') {
      consent.resolve()
      await disable
      expect(consentDone).toHaveBeenCalledOnce()
      expect(filterDone).not.toHaveBeenCalled()
    } else {
      filter.resolve()
      await preferences
      expect(filterDone).toHaveBeenCalledOnce()
      expect(consentDone).not.toHaveBeenCalled()
    }
    mocks.listener?.({ ...token, token: 'd'.repeat(64) })
    await drain()
    expect(client.sendRequest).not.toHaveBeenCalled()
    consent.resolve()
    filter.resolve()
    await Promise.all([disable, preferences])
    await drain()
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      failure === 'consent' ? 'notifications.registerPush' : 'notifications.unregisterPush'
    ])
    expect(errors).toEqual(failure === 'none' ? [] : [`${failure} failed`])
    expect(consentDone).toHaveBeenCalledOnce()
    expect(filterDone).toHaveBeenCalledOnce()
    expect(records().pendingUnregisterHostIds).toEqual(
      failure === 'none' || failure === 'filter' ? ['host'] : []
    )
    rpc.resolve({ id: 'consent-test', ok: true, result: { registered: true, unregistered: true } })
    await drain()
    expect(records()).toEqual({
      registeredHostIds: failure === 'consent' ? ['host'] : [],
      pendingUnregisterHostIds: []
    })
  }
)

it.each(['records', 'consent'] as const)(
  'parks an existing reconcile suspended in %s and preserves T2 while local intent is pending',
  async (stage) => {
    stopSync()
    resetPushRegistrationForTests()
    mocks.storage.set('orca:pushServiceNotificationsEnabled', 'true')
    mocks.storage.set(
      'orca:remotePushHostRegistrations',
      JSON.stringify({ registeredHostIds: ['host'], pendingUnregisterHostIds: [] })
    )
    const read = deferred<void>()
    const write = deferred<void>()
    const initialNative = deferred<MobilePushToken | null>()
    vi.mocked(getDevicePushToken).mockImplementationOnce(() => initialNative.promise)
    const get = vi.mocked(AsyncStorage.getItem).getMockImplementation()
    const save = vi.mocked(AsyncStorage.setItem).getMockImplementation()
    if (!get || !save) {
      throw new Error('Missing storage ports')
    }
    let suspended = false
    let hostAttached = false
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => {
      if (
        hostAttached &&
        !suspended &&
        key ===
          (stage === 'records'
            ? 'orca:remotePushHostRegistrations'
            : 'orca:pushServiceNotificationsEnabled')
      ) {
        suspended = true
        await read.promise
      }
      return get(key)
    })
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
      if (key === 'orca:notificationDeliveryPreferences') {
        await write.promise
      }
      await save(key, value)
    })
    stopSync = startPushTokenSync()
    await drain()
    expect(getDevicePushToken).toHaveBeenCalledOnce()
    mocks.listener?.(token)
    await drain()
    hostAttached = true
    const client = connection()
    const detach = attachPushRegistration('host', client)
    await drain()
    expect(suspended).toBe(true)
    const local = setNotificationDeliveryPreferences({
      onlyWhenDesktopAway: false,
      sound: false,
      suppressWhileViewing: true
    })
    const t2 = { ...token, token: 'e'.repeat(64) }
    mocks.listener?.(t2)
    read.resolve()
    initialNative.resolve(token)
    await drain()
    expect(
      client.sendRequest.mock.calls.filter(([method]) => method !== 'status.get')
    ).toHaveLength(0)
    write.resolve()
    await local
    await drain()
    const requests = client.sendRequest.mock.calls.filter(
      ([method]) => method === 'notifications.registerPush'
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject([
      'notifications.registerPush',
      { token: t2.token, filter: { sound: false, onlyWhenDesktopAway: false } },
      { failWhenDisconnected: true, timeoutMs: 5000 }
    ])
    detach()
  }
)
