import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NotificationDisplayTest } from './notification-display-test'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

const mocks = vi.hoisted(() => ({
  loadHosts: vi.fn(),
<<<<<<< HEAD
  loadPushNotificationsEnabled: vi.fn(async () => true),
  clients: [] as { state: string; client: { sendRequest: ReturnType<typeof vi.fn> } }[],
  getDevicePushToken: vi.fn(async (): Promise<{ platform: 'android'; token: string } | null> => ({
    platform: 'android',
    token: 'fcm-1'
  })),
  sendLocalNotificationDisplayTest: vi.fn(async () => {})
=======
  token: vi.fn(),
  supported: vi.fn(),
  completion: { completed: Promise.resolve(true), signal: new AbortController().signal },
  enabled: vi.fn(),
  permission: vi.fn(),
  schedule: vi.fn(),
  clients: [] as { state: string; client: { sendRequest: ReturnType<typeof vi.fn> } }[]
>>>>>>> upstream/main
}))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value, absoluteFillObject: {} }
}))
vi.mock('../storage/preferences', () => ({
  loadPushNotificationsEnabled: mocks.loadPushNotificationsEnabled
}))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: mocks.loadHosts }))
vi.mock('../transport/use-all-host-clients', () => ({ useAllHostClients: () => mocks.clients }))
<<<<<<< HEAD
vi.mock('../notifications/push-token', () => ({ getDevicePushToken: mocks.getDevicePushToken }))
vi.mock('../notifications/push-socket-fallback', () => ({
  sendLocalNotificationDisplayTest: mocks.sendLocalNotificationDisplayTest
}))
=======
vi.mock('../notifications/push-token', () => ({ getDevicePushToken: mocks.token }))
vi.mock('../notifications/push-registration', () => ({
  getHostPushSupported: mocks.supported,
  getHostPushSupportCompletion: () => mocks.completion
}))
vi.mock('../storage/preferences', () => ({ loadPushNotificationsEnabled: mocks.enabled }))
vi.mock('../notifications/notification-permissions', () => ({
  getNotificationPermissionState: mocks.permission
}))
vi.mock('../notifications/notification-delivery-preferences', () => ({
  loadNotificationDeliveryPreferences: async () => ({ sound: true })
}))
vi.mock('../notifications/desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: vi.fn(),
  DESKTOP_NOTIFICATION_CHANNEL_ID: 'orca-desktop'
}))
vi.mock('expo-notifications', () => ({ scheduleNotificationAsync: mocks.schedule }))
>>>>>>> upstream/main

let renderer: ReactTestRenderer
beforeEach(() => {
  mocks.loadHosts.mockReset().mockResolvedValue([{ id: 'first' }, { id: 'second' }])
  mocks.loadPushNotificationsEnabled.mockReset().mockResolvedValue(true)
  mocks.clients = []
<<<<<<< HEAD
  mocks.getDevicePushToken.mockReset().mockResolvedValue({ platform: 'android', token: 'fcm-1' })
  mocks.sendLocalNotificationDisplayTest.mockReset().mockResolvedValue(undefined)
=======
  mocks.token.mockReset().mockResolvedValue({ platform: 'ios', token: 'token' })
  mocks.supported.mockReset().mockReturnValue(true)
  mocks.enabled.mockReset().mockResolvedValue(true)
  mocks.permission.mockReset().mockResolvedValue({ granted: true })
  mocks.schedule.mockReset().mockResolvedValue('local')
>>>>>>> upstream/main
})
afterEach(() => act(() => renderer?.unmount()))

async function send() {
  await act(async () => {
    renderer = create(createElement(NotificationDisplayTest, { onTroubleshoot: vi.fn() }))
  })
  await act(async () => findAllByHostType(renderer.root, 'Pressable')[0].props.onPress())
}

it.each([
  { ok: false, error: { code: 'method_not_found' } },
  { ok: false, error: { code: 'forbidden' } },
  { ok: true, result: { accepted: false, reason: 'not_registered' } }
])('tries the next desktop after a definitive non-delivery response %j', async (response) => {
  const first = vi.fn().mockResolvedValue(response)
  const second = vi.fn().mockResolvedValue({ ok: true, result: { accepted: true } })
  const third = vi.fn()
  mocks.clients = [first, second, third].map((sendRequest) => ({
    state: 'connected',
    client: { sendRequest }
  }))
  await send()
  expect(second).toHaveBeenCalledExactlyOnceWith('notifications.testPush', null, {
    timeoutMs: 20000,
    failWhenDisconnected: true
  })
  expect(third).not.toHaveBeenCalled()
  expect(JSON.stringify(renderer.toJSON())).toContain('Accepted by Orca’s push service')
})

it('does not try another desktop after an uncertain transport failure', async () => {
  const second = vi.fn()
  mocks.clients = [
    {
      state: 'connected',
      client: { sendRequest: vi.fn().mockRejectedValue(new Error('timeout')) }
    },
    { state: 'connected', client: { sendRequest: second } }
  ]
  await send()
  expect(second).not.toHaveBeenCalled()
  expect(JSON.stringify(renderer.toJSON())).toContain('timeout')
})

it('explains when every desktop needs registration or an update', async () => {
  mocks.clients = [
    { ok: true, result: { accepted: false, reason: 'not_registered' } },
    { ok: false, error: { code: 'method_not_found' } }
  ].map((response) => ({
    state: 'connected',
    client: { sendRequest: vi.fn().mockResolvedValue(response) }
  }))
  await send()
<<<<<<< HEAD
  expect(mocks.sendLocalNotificationDisplayTest).not.toHaveBeenCalled()
  expect(JSON.stringify(renderer.toJSON())).toContain('Reconnect to register this phone')
=======
  const output = JSON.stringify(renderer.toJSON())
  expect(output).toContain('Push registration is not ready')
  expect(output).toContain('This checks display only')
  expect(output).not.toContain('Live alerts are available')
>>>>>>> upstream/main
})

it('sends a local test when no connected desktop can register a phone without push', async () => {
  mocks.getDevicePushToken.mockResolvedValue(null)
  const sendRequests = [
    { ok: true, result: { accepted: false, reason: 'not_registered' } },
    { ok: true, result: { accepted: false, reason: 'not_registered' } }
  ].map((response) => vi.fn().mockResolvedValue(response))
  mocks.clients = sendRequests.map((sendRequest) => ({
    state: 'connected',
    client: { sendRequest }
  }))
  await send()
  expect(sendRequests[0]).toHaveBeenCalledOnce()
  expect(sendRequests[1]).toHaveBeenCalledOnce()
  expect(mocks.sendLocalNotificationDisplayTest).toHaveBeenCalledOnce()
  expect(JSON.stringify(renderer.toJSON())).toContain(
    'Sent a local test notification. Live connection alerts are active on this device.'
  )
})

it('does not send a local test when notifications are disabled or token probe times out', async () => {
  mocks.getDevicePushToken.mockResolvedValue(null)
  mocks.loadPushNotificationsEnabled.mockResolvedValue(false)
  mocks.clients = [
    {
      state: 'connected',
      client: {
        sendRequest: vi
          .fn()
          .mockResolvedValue({ ok: true, result: { accepted: false, reason: 'not_registered' } })
      }
    }
  ]
  await send()
  expect(mocks.sendLocalNotificationDisplayTest).not.toHaveBeenCalled()
  expect(JSON.stringify(renderer.toJSON())).toContain('Reconnect to register this phone')

  vi.useFakeTimers()
  try {
    mocks.loadPushNotificationsEnabled.mockResolvedValue(true)
    mocks.getDevicePushToken.mockImplementation(() => new Promise(() => {}))
    await act(async () => {
      renderer = create(createElement(NotificationDisplayTest, { onTroubleshoot: vi.fn() }))
    })
    const pressPromise = act(async () => {
      renderer.root.findAllByType('Pressable')[0].props.onPress()
      await vi.advanceTimersByTimeAsync(1600)
    })
    await pressPromise
    expect(mocks.sendLocalNotificationDisplayTest).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toContain('Reconnect to register this phone')
  } finally {
    vi.useRealTimers()
  }
})

it.each([false, true])('explains missing pairing or connection (paired=%s)', async (paired) => {
  if (!paired) {
    mocks.loadHosts.mockResolvedValue([])
  }
  await send()
  expect(JSON.stringify(renderer.toJSON())).toContain(
    paired ? 'Connect a desktop' : 'Pair a desktop'
  )
})

it.each(['no-token', 'old-host'])('explains %s and schedules only a local test', async (reason) => {
  const request = vi.fn().mockResolvedValue({ ok: false, error: { code: 'method_not_found' } })
  mocks.clients = [{ state: 'connected', client: { sendRequest: request } }]
  if (reason === 'no-token') {
    mocks.token.mockResolvedValue(null)
  } else {
    mocks.supported.mockReturnValue(false)
    mocks.token.mockReturnValue(new Promise(() => {}))
  }
  await send()
  expect(mocks.schedule).toHaveBeenCalledOnce()
  expect(request).not.toHaveBeenCalled()
  const output = JSON.stringify(renderer.toJSON())
  expect(output).toContain(reason === 'no-token' ? 'No push token' : 'does not support push')
  expect(output).toContain('Local test scheduled')
  expect(output).toContain('while Orca is running and connected')
})

it.each(['app', 'os'])(
  'explains notifications disabled by %s without sending any test',
  async (disabledBy) => {
    const request = vi.fn().mockResolvedValue({ ok: true, result: { accepted: true } })
    mocks.clients = [{ state: 'connected', client: { sendRequest: request } }]
    if (disabledBy === 'app') {
      mocks.enabled.mockResolvedValue(false)
    } else {
      mocks.permission.mockResolvedValue({ granted: false })
    }
    await send()
    expect(JSON.stringify(renderer.toJSON())).toContain('Notifications are turned off')
    expect(request).not.toHaveBeenCalled()
    expect(mocks.schedule).not.toHaveBeenCalled()
  }
)
