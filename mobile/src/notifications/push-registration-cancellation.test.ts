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
import { ensureDesktopNotificationChannel } from './desktop-notification-channel'
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: vi.fn(async () => {})
}))
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  attachPushRegistration,
  resetPushRegistrationForTests,
  setRemotePushEnabled,
  startPushTokenSync,
  unregisterPushForRemovedHost,
  NOTIFICATIONS_REMOTE_PUSH_CAPABILITY
} from './push-registration'
import { addPushTokenListener, getDevicePushToken } from './push-token'
import type { MobilePushToken } from './push-token'
import { isRpcResponse } from '../transport/rpc-response-shape'

import AsyncStorage from '@react-native-async-storage/async-storage'
import { removeHost } from '../transport/host-store'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
vi.mock('../transport/host-store', () => ({ removeHost: vi.fn() }))
vi.mock('../mobile-web-shell/removed-host-shell-cache', () => ({
  forgetHostUpdateFailures: async () => undefined,
  deleteHostPageCache: async () => undefined
}))
vi.mock('./mobile-push-lease-renewal', () => ({ startMobilePushLeaseRenewal: () => () => {} }))

const storage = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value)
    })
  }
}))
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))
vi.mock('./push-token', () => ({ getDevicePushToken: vi.fn(), addPushTokenListener: vi.fn() }))
const token: MobilePushToken = {
  platform: 'ios',
  token: 'a'.repeat(64),
  apnsEnvironment: 'sandbox'
}
const records = () => JSON.parse(storage.get('orca:remotePushHostRegistrations') ?? '{}')
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function client(
  register: () => Promise<unknown> = async () => ({ ok: true, result: { registered: true } })
) {
  if (!rootStarted) {
    rootStarted = true
    startPushTokenSync()
  }
  return {
    sendRequest: vi.fn(async (method: string, _params?: unknown, _options?: unknown) => {
      if (method === 'status.get') {
        return { ok: true, result: { capabilities: [NOTIFICATIONS_REMOTE_PUSH_CAPABILITY] } }
      }
      if (method === 'notifications.registerPush') {
        return register()
      }
      return { ok: true, result: { unregistered: true } }
    })
  }
}
let rootStarted = false
beforeEach(() => {
  rootStarted = false
  vi.clearAllMocks()
  resetPushRegistrationForTests()
  storage.clear()
  storage.set('orca:pushServiceNotificationsEnabled', 'true')
  vi.mocked(getDevicePushToken).mockResolvedValue(token)
  vi.mocked(addPushTokenListener).mockReturnValue(() => {})
  vi.mocked(removeHost).mockReset()
})

afterEach(() => {
  resetPushRegistrationForTests()
  vi.useRealTimers()
})

it('does not resurrect a removed host when its registration response arrives late', async () => {
  const pending = deferred<unknown>()
  const connection = client(() => pending.promise)
  attachPushRegistration('host', connection as never)
  await vi.waitFor(() =>
    expect(connection.sendRequest).toHaveBeenCalledWith(
      'notifications.registerPush',
      expect.anything(),
      expect.anything()
    )
  )
  const removal = unregisterPushForRemovedHost('host')
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).not.toContain(
    'notifications.unregisterPush'
  )
  pending.resolve({ ok: true, result: { registered: true } })
  await removal
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(records().registeredHostIds).toEqual([])
  expect(records().pendingUnregisterHostIds).toEqual([])
})

it('does not start registration after removal while native token lookup was pending', async () => {
  const pending = deferred<MobilePushToken | null>()
  vi.mocked(getDevicePushToken).mockReturnValueOnce(pending.promise)
  const connection = client()
  attachPushRegistration('host', connection as never)
  await vi.waitFor(() => expect(getDevicePushToken).toHaveBeenCalled())
  await unregisterPushForRemovedHost('host')
  pending.resolve(token)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).not.toContain(
    'notifications.registerPush'
  )
})

it('does not register with stale consent after the user disables notifications during token lookup', async () => {
  const pending = deferred<MobilePushToken | null>()
  vi.mocked(getDevicePushToken).mockReturnValueOnce(pending.promise)
  const connection = client()
  attachPushRegistration('host', connection as never)
  await vi.waitFor(() => expect(getDevicePushToken).toHaveBeenCalled())
  const disabled = setRemotePushEnabled(false)
  pending.resolve(token)
  await disabled
  await vi.waitFor(() =>
    expect(connection.sendRequest.mock.calls.map(([method]) => method)).toContain(
      'notifications.unregisterPush'
    )
  )
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).not.toContain(
    'notifications.registerPush'
  )
})

it('waits for notification channel readiness before requesting a token', async () => {
  const pending = deferred<void>()
  vi.mocked(ensureDesktopNotificationChannel).mockReturnValueOnce(pending.promise)
  const connection = client()
  attachPushRegistration('host', connection as never)
  await vi.waitFor(() => expect(ensureDesktopNotificationChannel).toHaveBeenCalled())
  expect(getDevicePushToken).not.toHaveBeenCalled()
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).not.toContain(
    'notifications.registerPush'
  )
  pending.resolve()
  await vi.waitFor(() =>
    expect(connection.sendRequest.mock.calls.map(([method]) => method)).toContain(
      'notifications.registerPush'
    )
  )
})

it('completes disable while native token acquisition remains unresolved, and rejects late tokens', async () => {
  vi.useFakeTimers()
  storage.set(
    'orca:remotePushHostRegistrations',
    JSON.stringify({
      registeredHostIds: ['host'],
      pendingUnregisterHostIds: []
    })
  )
  const pending = deferred<MobilePushToken | null>()
  vi.mocked(getDevicePushToken).mockReturnValueOnce(pending.promise)
  const connection = client()
  const stop = startPushTokenSync()
  attachPushRegistration('host', connection as never)
  await vi.advanceTimersByTimeAsync(0)
  expect(getDevicePushToken).toHaveBeenCalledOnce()
  await setRemotePushEnabled(false)
  expect(records().pendingUnregisterHostIds).toEqual(['host'])
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).not.toContain(
    'notifications.unregisterPush'
  )
  await vi.advanceTimersByTimeAsync(2_000)
  expect(storage.get('orca:pushServiceNotificationsEnabled')).toBe('false')
  expect(records()).toEqual({ registeredHostIds: [], pendingUnregisterHostIds: [] })
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).toContain(
    'notifications.unregisterPush'
  )
  pending.resolve(token)
  vi.mocked(addPushTokenListener).mock.calls[0]![0](token)
  await vi.advanceTimersByTimeAsync(0)
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).not.toContain(
    'notifications.registerPush'
  )
  stop()
})

it('restores registration without reconnect after metadata removal fails, retaining detach ownership', async () => {
  const connection = client()
  const detach = attachPushRegistration('host', connection as never)
  await vi.waitFor(() => expect(records().registeredHostIds).toEqual(['host']))
  vi.mocked(removeHost).mockRejectedValueOnce(new Error('metadata failure'))
  const close = vi.fn()
  await expect(removeHostAndCloseClient('host', close)).rejects.toThrow('metadata failure')
  expect(close).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(records().registeredHostIds).toEqual(['host']))
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).toEqual([
    'status.get',
    'notifications.registerPush',
    'notifications.unregisterPush',
    'status.get',
    'notifications.registerPush'
  ])
  detach()
  connection.sendRequest.mockClear()
  await setRemotePushEnabled(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(connection.sendRequest).not.toHaveBeenCalled()
})

it('does not revive a connection detached while metadata removal was pending', async () => {
  const connection = client()
  const detach = attachPushRegistration('host', connection as never)
  await vi.waitFor(() => expect(records().registeredHostIds).toEqual(['host']))
  const commit = deferred<void>()
  vi.mocked(removeHost).mockImplementationOnce(async () => {
    await commit.promise
    throw new Error('metadata failure')
  })
  const removal = expect(removeHostAndCloseClient('host', vi.fn())).rejects.toThrow(
    'metadata failure'
  )
  await vi.waitFor(() => expect(removeHost).toHaveBeenCalled())
  detach()
  connection.sendRequest.mockClear()
  commit.resolve()
  await removal
  await setRemotePushEnabled(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(connection.sendRequest).not.toHaveBeenCalled()
})

it('retires late registration ownership before a failed removal restores a fresh registration', async () => {
  const oldRegister = deferred<unknown>()
  const newRegister = deferred<unknown>()
  const register = vi
    .fn()
    .mockReturnValueOnce(oldRegister.promise)
    .mockReturnValue(newRegister.promise)
  const connection = client(register)
  attachPushRegistration('host', connection as never)
  await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
  vi.mocked(removeHost).mockRejectedValueOnce(new Error('metadata failure'))
  const removal = expect(removeHostAndCloseClient('host', vi.fn())).rejects.toThrow(
    'metadata failure'
  )
  expect(connection.sendRequest.mock.calls.map(([method]) => method)).not.toContain(
    'notifications.unregisterPush'
  )
  oldRegister.resolve({ ok: true, result: { registered: true } })
  await removal
  await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(2))
  expect(records().registeredHostIds).toEqual([])
  newRegister.resolve({ ok: true, result: { registered: true } })
  await vi.waitFor(() => expect(records().registeredHostIds).toEqual(['host']))
})

it('still commits removal when unregister and cleanup storage fail', async () => {
  const connection = client()
  attachPushRegistration('host', connection as never)
  await vi.waitFor(() => expect(records().registeredHostIds).toEqual(['host']))
  connection.sendRequest.mockRejectedValueOnce(new Error('socket closed'))
  vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'))
  const close = vi.fn()
  await removeHostAndCloseClient('host', close)
  expect(removeHost).toHaveBeenCalledWith('host')
  expect(close).toHaveBeenCalledWith('host')
})

it('shares a timed-out native acquisition, keeps listener T2 over late T1 and retires callbacks at restart', async () => {
  vi.useFakeTimers()
  const pending = deferred<MobilePushToken | null>()
  vi.mocked(getDevicePushToken).mockReturnValueOnce(pending.promise)
  const first = client()
  const second = client()
  const withRpcResponses = (
    connection: ReturnType<typeof client>
  ): Parameters<typeof attachPushRegistration>[1] => ({
    sendRequest: async (method, params, options) => {
      const result = await connection.sendRequest(method, params, options)
      if (!result || typeof result !== 'object') {
        throw new Error('Missing actual fixture reply')
      }
      const response = { ...result, id: 'native-race' }
      if (!isRpcResponse(response)) {
        throw new Error('Invalid fixture RPC reply')
      }
      return response
    }
  })
  attachPushRegistration('first', withRpcResponses(first))
  attachPushRegistration('second', withRpcResponses(second))
  await vi.advanceTimersByTimeAsync(2000)
  expect(getDevicePushToken).toHaveBeenCalledOnce()
  expect(
    first.sendRequest.mock.calls.some(([method]) => method === 'notifications.registerPush')
  ).toBe(false)
  const listener = vi.mocked(addPushTokenListener).mock.calls.at(-1)?.[0]
  if (!listener) {
    throw new Error('Missing actual native listener')
  }
  const next = { ...token, token: 'b'.repeat(64) }
  const consentWrite = deferred<void>()
  vi.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => {
    await consentWrite.promise
    storage.set(key, value)
  })
  const renewedConsent = setRemotePushEnabled(true)
  listener(next)
  consentWrite.resolve()
  await renewedConsent
  await vi.advanceTimersByTimeAsync(0)
  pending.resolve(token)
  listener(next)
  await vi.advanceTimersByTimeAsync(0)
  for (const connection of [first, second]) {
    const registrations = connection.sendRequest.mock.calls.filter(
      ([method]) => method === 'notifications.registerPush'
    )
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.[1]).toMatchObject({ token: next.token })
  }
  resetPushRegistrationForTests()
  const before = first.sendRequest.mock.calls.length
  startPushTokenSync()
  listener(token)
  await vi.advanceTimersByTimeAsync(0)
  expect(first.sendRequest).toHaveBeenCalledTimes(before)
})
