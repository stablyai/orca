import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { addPushTokenListener, getDevicePushToken } from './push-token'

vi.mock('expo-notifications', () => ({
  getDevicePushTokenAsync: vi.fn(),
  addPushTokenListener: vi.fn()
}))

const dev = globalThis as { __DEV__?: boolean }

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  delete dev.__DEV__
})

describe('getDevicePushToken', () => {
  it.each([
    [true, 'sandbox'],
    [false, 'production']
  ])('reports apnsEnvironment for a __DEV__=%s iOS build as %s', async (isDev, environment) => {
    dev.__DEV__ = isDev
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
      type: 'ios',
      data: 'a'.repeat(64)
    } as never)

    await expect(getDevicePushToken()).resolves.toEqual({
      platform: 'ios',
      token: 'a'.repeat(64),
      apnsEnvironment: environment
    })
  })

  it('omits apnsEnvironment for Android, where FCM has no environment split', async () => {
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
      type: 'android',
      data: 'fcm-registration-token'
    } as never)

    await expect(getDevicePushToken()).resolves.toEqual({
      platform: 'android',
      token: 'fcm-registration-token'
    })
  })

  it.each([
    ['a web push subscription', { type: 'web', data: { endpoint: 'https://example.test' } }],
    ['an empty token', { type: 'ios', data: '' }]
  ])('returns null for %s', async (_label, raw) => {
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue(raw as never)

    await expect(getDevicePushToken()).resolves.toBeNull()
  })

  it('returns null when the shell cannot mint a token at all', async () => {
    vi.mocked(Notifications.getDevicePushTokenAsync).mockRejectedValue(new Error('no entitlement'))

    await expect(getDevicePushToken()).resolves.toBeNull()
  })
})

describe('addPushTokenListener', () => {
  it('forwards a rolled native token and removes the subscription on teardown', () => {
    const remove = vi.fn()
    let emit: ((raw: unknown) => void) | null = null
    vi.mocked(Notifications.addPushTokenListener).mockImplementation((listener) => {
      emit = listener as (raw: unknown) => void
      return { remove } as never
    })
    const seen: unknown[] = []

    const stop = addPushTokenListener((token) => seen.push(token))
    emit?.({ type: 'android', data: 'rolled' })
    emit?.({ type: 'web', data: {} })
    stop()

    expect(seen).toEqual([{ platform: 'android', token: 'rolled' }])
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('degrades to a no-op on a shell that cannot subscribe to token changes', () => {
    vi.mocked(Notifications.addPushTokenListener).mockImplementation(() => {
      throw new Error('no push support')
    })

    expect(() => addPushTokenListener(() => {})()).not.toThrow()
  })
})
