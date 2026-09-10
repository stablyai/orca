vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: vi.fn(async () => {})
}))
import { AppState } from 'react-native'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  attachPushRegistration,
  resetPushRegistrationForTests,
  setNotificationDeliveryPreferences,
  NOTIFICATIONS_REMOTE_PUSH_CAPABILITY
} from './push-registration'
import { DEFAULT_NOTIFICATION_DELIVERY } from './notification-delivery-preferences'

const storage = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value)
    })
  }
}))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) }
}))

vi.mock('./push-token', () => ({
  getDevicePushToken: vi.fn(async () => ({
    platform: 'ios',
    token: 'a'.repeat(64),
    apnsEnvironment: 'sandbox'
  })),
  addPushTokenListener: vi.fn()
}))

beforeEach(() => {
  AppState.currentState = 'active'
  resetPushRegistrationForTests()
  storage.clear()
  storage.set('orca:pushNotificationsEnabled', 'true')
})

it('replaces an in-flight registration with the latest away and sound preferences', async () => {
  const calls: { method: string; params: unknown }[] = []
  let finishFirst: ((value: unknown) => void) | undefined
  const client = {
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === 'status.get') {
        return { ok: true, result: { capabilities: [NOTIFICATIONS_REMOTE_PUSH_CAPABILITY] } }
      }
      if (method === 'notifications.registerPush') {
        if (!finishFirst) {
          return new Promise((resolve) => {
            finishFirst = resolve
          })
        }
        return { ok: true, result: { registered: true, registrationId: 'new' } }
      }
      return { ok: true, result: { unregistered: true } }
    })
  }
  const detach = attachPushRegistration('host', client as never)
  await vi.waitFor(() => expect(finishFirst).toBeDefined())
  const update = setNotificationDeliveryPreferences({
    ...DEFAULT_NOTIFICATION_DELIVERY,
    onlyWhenDesktopAway: false,
    sound: false
  })
  finishFirst!({ ok: true, result: { registered: true, registrationId: 'old' } })
  await update
  await vi.waitFor(() =>
    expect(
      calls.filter((call) => call.method === 'notifications.registerPush').length
    ).toBeGreaterThan(1)
  )
  const latest = calls.findLast((call) => call.method === 'notifications.registerPush')
  expect(latest?.params).toMatchObject({
    filter: {
      onlyWhenDesktopAway: false,
      sound: false
    }
  })
  expect(calls.some((call) => call.method === 'notifications.unregisterPush')).toBe(true)
  detach()
})
