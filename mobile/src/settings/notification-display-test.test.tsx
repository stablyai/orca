import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NotificationDisplayTest } from './notification-display-test'

const mocks = vi.hoisted(() => ({
  loadHosts: vi.fn(),
  loadPushNotificationsEnabled: vi.fn(async () => true),
  clients: [] as { state: string; client: { sendRequest: ReturnType<typeof vi.fn> } }[],
  getDevicePushToken: vi.fn(async (): Promise<{ platform: 'android'; token: string } | null> => ({
    platform: 'android',
    token: 'fcm-1'
  })),
  sendLocalNotificationDisplayTest: vi.fn(async () => {})
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
vi.mock('../notifications/push-token', () => ({ getDevicePushToken: mocks.getDevicePushToken }))
vi.mock('../notifications/push-socket-fallback', () => ({
  sendLocalNotificationDisplayTest: mocks.sendLocalNotificationDisplayTest
}))

let renderer: ReactTestRenderer
beforeEach(() => {
  mocks.loadHosts.mockReset().mockResolvedValue([{ id: 'first' }, { id: 'second' }])
  mocks.loadPushNotificationsEnabled.mockReset().mockResolvedValue(true)
  mocks.clients = []
  mocks.getDevicePushToken.mockReset().mockResolvedValue({ platform: 'android', token: 'fcm-1' })
  mocks.sendLocalNotificationDisplayTest.mockReset().mockResolvedValue(undefined)
})
afterEach(() => act(() => renderer?.unmount()))

async function send() {
  await act(async () => {
    renderer = create(createElement(NotificationDisplayTest, { onTroubleshoot: vi.fn() }))
  })
  await act(async () => renderer.root.findAllByType('Pressable')[0].props.onPress())
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
  expect(mocks.sendLocalNotificationDisplayTest).not.toHaveBeenCalled()
  expect(JSON.stringify(renderer.toJSON())).toContain('Reconnect to register this phone')
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
