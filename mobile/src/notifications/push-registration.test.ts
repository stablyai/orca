vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) }
}))
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: vi.fn(async () => {})
}))
import { AppState } from 'react-native'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
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
