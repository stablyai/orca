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
  startPushTokenSync
} from './push-registration'
import { getDevicePushToken } from './push-token'

const mocks = vi.hoisted(() => ({ storage: new Map<string, string>(), replace: vi.fn() }))
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
  addPushTokenListener: () => () => {}
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
    sendRequest: vi.fn(async (method: string): Promise<unknown> => ({
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
  attachPushRegistration('host', client as never)
  await drain()
  client.sendRequest.mockClear()
  return client
}
async function choose(entry: string) {
  await act(async () => {
    renderer = create(
      createElement(entry === 'settings' ? NotificationsScreen : MobileOnboardingScreen)
    )
  })
  await act(async () => {
    if (entry === 'settings') {
      renderer!.root.findByType('Switch').props.onValueChange(true)
    } else {
      renderer!.root.findByType('Page').props.onNotificationChoice('enable')
    }
  })
}
function expectChoiceComplete(entry: string) {
  expect(mocks.storage.get('orca:pushServiceNotificationsEnabled')).toBe('true')
  if (entry === 'settings') {
    expect(renderer!.root.findByType('Switch').props).toMatchObject({
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
  await act(async () => {
    renderer!.root.findByType('Page').props.onNotificationChoice('skip')
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
    const pending = deferred<unknown>()
    client.sendRequest.mockImplementationOnce(() => pending.promise)
    await choose(entry)
    await drain()
    expectChoiceComplete(entry)
    expect(client.sendRequest).toHaveBeenCalledOnce()
    expect(records().registeredHostIds).toEqual([])
    pending.resolve({ ok: true, result: { registered: true } })
    await drain()
    expect(records().registeredHostIds).toEqual(['host'])
    expect(client.sendRequest).toHaveBeenCalledOnce()
  }
)

it('waits for durable local records and schedules one unregister without waiting for its RPC', async () => {
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
  const rpc = deferred<unknown>()
  client.sendRequest.mockImplementationOnce(() => rpc.promise)
  const completed = vi.fn()
  const disable = setRemotePushEnabled(false).then(completed)
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
  rpc.resolve({ ok: true })
  await drain()
  expect(records()).toEqual({ registeredHostIds: [], pendingUnregisterHostIds: [] })
  expect(client.sendRequest).toHaveBeenCalledOnce()
})

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
