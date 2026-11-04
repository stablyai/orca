vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) }
}))
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: vi.fn(async () => {})
}))
import { AppState } from 'react-native'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RpcResponse } from '../transport/types'
import {
  loadPushNotificationsEnabled,
  loadRemotePushHostRegistrations,
  savePushNotificationsEnabled,
  saveRemotePushHostRegistrations,
  type RemotePushHostRegistrations
} from '../storage/preferences'
import { getDevicePushToken, type MobilePushToken } from './push-token'
import {
  NOTIFICATIONS_REMOTE_PUSH_CAPABILITY,
  attachPushRegistration,
  isHostPushRegistered,
  resetPushRegistrationForTests,
  setRemotePushEnabled
} from './push-registration'

vi.mock('../storage/preferences', () => ({
  loadPushNotificationsEnabled: vi.fn(),
  savePushNotificationsEnabled: vi.fn(),
  loadRemotePushHostRegistrations: vi.fn(),
  saveRemotePushHostRegistrations: vi.fn()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) }
}))

vi.mock('./push-token', () => ({
  getDevicePushToken: vi.fn(),
  addPushTokenListener: vi.fn()
}))

const IOS_TOKEN: MobilePushToken = {
  platform: 'ios',
  token: 'a'.repeat(64),
  apnsEnvironment: 'production'
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function ok(result: unknown): RpcResponse {
  return { id: 'req', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

let enabled = false
let stored: RemotePushHostRegistrations

beforeEach(() => {
  vi.clearAllMocks()
  AppState.currentState = 'active'
  resetPushRegistrationForTests()
  enabled = false
  stored = { registeredHostIds: [], pendingUnregisterHostIds: [] }

  vi.mocked(loadPushNotificationsEnabled).mockImplementation(async () => enabled)
  vi.mocked(savePushNotificationsEnabled).mockImplementation(async (value) => {
    enabled = value
  })
  vi.mocked(loadRemotePushHostRegistrations).mockImplementation(async () => stored)
  vi.mocked(saveRemotePushHostRegistrations).mockImplementation(async (value) => {
    stored = value
  })
  vi.mocked(getDevicePushToken).mockResolvedValue(IOS_TOKEN)
})

describe('push registration capability gating', () => {
  it('re-probes a host whose first status.get never answered', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    let probeFails = true
    const client = {
      sendRequest: vi.fn(async (method: string) => {
        sent.push(method)
        if (method === 'status.get') {
          if (probeFails) {
            throw new Error('request timed out')
          }
          return ok({ capabilities: [NOTIFICATIONS_REMOTE_PUSH_CAPABILITY] })
        }
        return ok({ registered: true, registrationId: 'registration-1' })
      })
    }
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['status.get'])

    probeFails = false
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(sent).toEqual(['status.get', 'status.get', 'notifications.registerPush'])
    vi.useRealTimers()
  })
})

describe('push unregistration', () => {
  it('re-arms the unregister when the switch goes off while a register is in flight', async () => {
    const sent: string[] = []
    const register: { release?: () => void } = {}
    const client = {
      sendRequest: vi.fn(async (method: string) => {
        sent.push(method)
        if (method === 'status.get') {
          return ok({ capabilities: [NOTIFICATIONS_REMOTE_PUSH_CAPABILITY] })
        }
        if (method === 'notifications.registerPush') {
          await new Promise<void>((resolve) => {
            register.release = resolve
          })
          return ok({ registered: true, registrationId: 'registration-1' })
        }
        return ok({ unregistered: true })
      })
    }
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await flush()

    const switchedOff = setRemotePushEnabled(false)
    await flush()
    register.release?.()
    await switchedOff
    await flush()

    // Do not record late register success after disable; it would leave a live gateway route with no pending unregister.
    expect(sent).toContain('notifications.unregisterPush')
    expect(stored).toEqual({ registeredHostIds: [], pendingUnregisterHostIds: [] })
  })
})
function makeClient(capabilities: readonly string[]): {
  client: {
    sendRequest: (method: string, params?: unknown, options?: unknown) => Promise<RpcResponse>
  }
  sent: Array<{ method: string }>
} {
  const sent: Array<{ method: string }> = []
  const client = {
    sendRequest: vi.fn(async (method: string) => {
      sent.push({ method })
      if (method === 'status.get') {
        return ok({ capabilities: [...capabilities] })
      }
      if (method === 'notifications.registerPush') {
        return ok({ registered: true, registrationId: 'registration-1' })
      }
      if (method === 'notifications.unregisterPush') {
        return ok({ unregistered: true })
      }
      return ok(null)
    })
  }
  return { client, sent }
}

function methodsIn(sent: Array<{ method: string }>): string[] {
  return sent.map((request) => request.method)
}

describe('isHostPushRegistered', () => {
  it('is true after the connected host registers push', async () => {
    const { client } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await flush()
    await expect(isHostPushRegistered('host-1')).resolves.toBe(true)
  })

  it('is false when the device has no push token', async () => {
    vi.mocked(getDevicePushToken).mockResolvedValue(null)
    const { client } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await flush()
    await expect(isHostPushRegistered('host-1')).resolves.toBe(false)
  })

  it('is false after remote push is switched off', async () => {
    const { client } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await flush()
    await setRemotePushEnabled(false)
    await flush()
    await expect(isHostPushRegistered('host-1')).resolves.toBe(false)
  })
})

it('does not register or renew when a connected phone is in the background', async () => {
  AppState.currentState = 'background'
  const { client, sent } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
  await setRemotePushEnabled(true)
  attachPushRegistration('background-phone', client)
  await flush()
  expect(methodsIn(sent)).not.toContain('notifications.registerPush')
  AppState.currentState = 'active'
  attachPushRegistration('background-phone', client)
  await flush()
  expect(methodsIn(sent)).toContain('notifications.registerPush')
})
