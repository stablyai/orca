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
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: vi.fn(async () => {})
}))
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  attachPushRegistration,
  startPushTokenSync,
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
  addPushTokenListener: vi.fn(() => () => {})
}))

beforeEach(() => {
  AppState.currentState = 'active'
  resetPushRegistrationForTests()
  storage.clear()
  storage.set('orca:pushServiceNotificationsEnabled', 'true')
  startPushTokenSync()
})
afterEach(resetPushRegistrationForTests)

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

it('reports a failed filter write and rederives the durable filter without waiting for remote work', async () => {
  const client = {
    sendRequest: vi.fn(async (method: string) => ({
      id: 'filter-failure',
      ok: true as const,
      result:
        method === 'status.get'
          ? { capabilities: [NOTIFICATIONS_REMOTE_PUSH_CAPABILITY] }
          : { registered: true }
    }))
  }
  attachPushRegistration('host', client)
  await vi.waitFor(() =>
    expect(
      client.sendRequest.mock.calls.some(([method]) => method === 'notifications.registerPush')
    ).toBe(true)
  )
  vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('filter write failed'))
  await expect(
    setNotificationDeliveryPreferences({ ...DEFAULT_NOTIFICATION_DELIVERY, sound: false })
  ).rejects.toThrow('filter write failed')
  await vi.waitFor(() =>
    expect(
      client.sendRequest.mock.calls.filter(([method]) => method === 'notifications.registerPush')
    ).toHaveLength(2)
  )
  expect(storage.has('orca:notificationDeliveryPreferences')).toBe(false)
  expect(client.sendRequest).toHaveBeenLastCalledWith(
    'notifications.registerPush',
    expect.objectContaining({ filter: { onlyWhenDesktopAway: true, sound: true } }),
    expect.anything()
  )
})
