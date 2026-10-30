import { vi } from 'vitest'
import type { MobilePushToken } from './push-token'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'

type Ports = {
  storage: Map<string, string>
  keys: Map<string, string>
  listener?: (token: MobilePushToken) => void
  foreground?: (state: string) => void
  finalFailure?: ReturnType<typeof Promise.withResolvers<void>>
  fault: string
  faultStarted?: (key: string) => void
  reads: number
  writes: number
  bytes: number
  native: MobilePushToken
  nativeHold?: ReturnType<typeof Promise.withResolvers<string>>
  channelHold?: ReturnType<typeof Promise.withResolvers<void>>
  consentHold?: { mode: 'disk' | 'reply'; gate: ReturnType<typeof Promise.withResolvers<void>> }
  consentResults: (string | null | Error)[]
  nativeCalls: number
  channelCalls: string[]
  consentCalls: number
  nativeGets: string[]
  listenerRemovals: number
  disk: Promise<void>
  session?: RpcClient
  keyReadStarted?: ReturnType<typeof Promise.withResolvers<void>>
  keyRead?: ReturnType<typeof Promise.withResolvers<void>>
  keyReads: number
  keyWrites: number
  metadataReads: number
  metadataWrites: number
}
const ports = vi.hoisted((): Ports => ({
  storage: new Map(),
  keys: new Map(),
  fault: '',
  consentResults: [],
  nativeCalls: 0,
  channelCalls: [],
  consentCalls: 0,
  nativeGets: [],
  listenerRemovals: 0,
  disk: Promise.resolve(),
  reads: 0,
  writes: 0,
  bytes: 0,
  keyReads: 0,
  keyWrites: 0,
  metadataReads: 0,
  metadataWrites: 0,
  native: { platform: 'ios', token: 'b'.repeat(64), apnsEnvironment: 'production' }
}))
vi.mock('expo/fetch', () => ({
  fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)
}))
vi.mock('../transport/rpc-client', () => ({
  connect: () => {
    if (!ports.session) {
      throw new Error('Missing external RPC session port')
    }
    return ports.session
  }
}))
const storagePort = {
  read: async (key: string) => {
    if (key === 'orca:pushServiceNotificationsEnabled') {
      ports.consentCalls++
      const result = ports.consentResults.shift()
      if (result instanceof Error) {
        throw result
      }
      if (result !== undefined) {
        return result
      }
    }
    if (key.startsWith('orca:pairing-keychain-')) {
      ports.metadataReads++
    }
    if (key === 'orca:push-route-version') {
      ports.reads++
    }
    if (key === 'orca:hosts') {
      ports.bytes += (ports.storage.get(key) ?? '').length
    }
    const fault = ports.fault
    if (fault === 'catalog-race' && key === 'orca:hosts') {
      ports.faultStarted?.(key)
      if (ports.reads === 3) {
        await ports.finalFailure?.promise
      }
      throw new Error('Controlled final catalog failure')
    }
    if (
      (ports.fault === 'catalog-read' && key === 'orca:hosts') ||
      (ports.fault === 'version-read' && key === 'orca:push-route-version')
    ) {
      ports.faultStarted?.(key)
      throw new Error('Controlled storage read failure')
    }
    if (ports.fault === 'non-array' && key === 'orca:hosts') {
      ports.faultStarted?.(key)
      return '{}'
    }
    return ports.storage.get(key) ?? null
  },
  write: async (key: string, value: string) => {
    if (key.startsWith('orca:pairing-keychain-')) {
      ports.metadataWrites++
    }
    if (key === 'orca:push-route-version') {
      ports.writes++
      if (ports.fault === 'version-write') {
        ports.faultStarted?.(key)
        throw new Error('Controlled storage write failure')
      }
    }
    ports.storage.set(key, value)
  }
}
function disk(operation: () => Promise<void>): void {
  ports.disk = ports.disk.then(operation)
}
vi.mock('@react-native-async-storage/async-storage/lib/module/RCTAsyncStorage', () => ({
  default: {
    multiGet: (
      keys: string[],
      callback: (errors: { message: string }[] | null, rows?: (string | null)[][]) => void
    ) => {
      ports.nativeGets.push(...keys)
      const hold = keys.includes('orca:pushServiceNotificationsEnabled')
        ? ports.consentHold
        : undefined
      disk(async () => {
        if (hold?.mode === 'disk') {
          await hold.gate.promise
        }
        try {
          const rows = await Promise.all(
            keys.map(async (key) => [key, await storagePort.read(key)])
          )
          if (hold?.mode === 'reply') {
            void hold.gate.promise.then(() => callback(null, rows))
          } else {
            callback(null, rows)
          }
        } catch (error) {
          callback([{ message: String(error) }])
        }
      })
    },
    multiSet: (
      rows: [string, string][],
      callback: (errors: { message: string }[] | null) => void
    ) =>
      disk(async () => {
        try {
          for (const [key, value] of rows) {
            await storagePort.write(key, value)
          }
          callback(null)
        } catch (error) {
          callback([{ message: String(error) }])
        }
      }),
    multiRemove: (keys: string[], callback: (errors: null) => void) =>
      disk(async () => {
        for (const key of keys) {
          ports.storage.delete(key)
        }
        callback(null)
      })
  }
}))
vi.mock('@react-native-async-storage/async-storage', async () => ({
  default: (
    await import('@react-native-async-storage/async-storage/lib/module/AsyncStorage.native')
  ).default
}))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: async (key: string) => {
    ports.keyReads++
    ports.keyReadStarted?.resolve()
    await ports.keyRead?.promise
    return ports.keys.get(key) ?? null
  },
  setItemAsync: async (key: string, value: string) => {
    ports.keyWrites++
    ports.keys.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    ports.keys.delete(key)
  }
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    currentState: 'active',
    addEventListener: (_: string, callback: typeof ports.foreground) => {
      ports.foreground = callback
      return {
        remove: () => {
          ports.foreground = undefined
        }
      }
    }
  }
}))
vi.mock('expo', async () => ({
  Platform: (await import('react-native')).Platform,
  UnavailabilityError: Error
}))
vi.mock('expo-modules-core', async () => ({
  Platform: (await import('react-native')).Platform,
  UnavailabilityError: Error
}))
vi.mock('expo-notifications/build/PushTokenManager', () => ({
  default: {
    getDevicePushTokenAsync: () => {
      ports.nativeCalls++
      return ports.nativeHold?.promise ?? Promise.resolve(ports.native.token)
    },
    addListener: (name: string, callback: (event: { devicePushToken: string }) => void) => {
      if (name !== 'onDevicePushToken') {
        throw new Error('Unexpected native token event')
      }
      const listener = (token: MobilePushToken) => callback({ devicePushToken: token.token })
      ports.listener = listener
      return {
        remove: () => {
          ports.listenerRemovals++
          if (ports.listener === listener) {
            ports.listener = undefined
          }
        }
      }
    }
  }
}))
vi.mock('expo-notifications/build/NotificationChannelManager', () => ({
  default: {
    setNotificationChannelAsync: async (id: string) => {
      ports.channelCalls.push(id)
      await ports.channelHold?.promise
      return null
    }
  }
}))
vi.mock('expo-notifications/build/warnOfExpoGoPushUsage', () => ({
  warnOfExpoGoPushUsage: () => {}
}))
vi.mock('expo-notifications', async () => ({
  ...(await import('expo-notifications/build/getDevicePushTokenAsync')),
  ...(await import('expo-notifications/build/TokenEmitter')),
  ...(await import('expo-notifications/build/setNotificationChannelAsync.android')),
  AndroidImportance: (await import('expo-notifications/build/NotificationChannelManager.types'))
    .AndroidImportance,
  getPresentedNotificationsAsync: async () => [],
  dismissNotificationAsync: async () => {}
}))
vi.mock('../i18n/mobile-i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

export function pushOwnerNativePorts(): Ports {
  return ports
}

export function pushOwnerRpcPort(keyed = false) {
  const sendRequest = vi.fn<RpcOperationSender['sendRequest']>(async (method) => ({
    id: 'native-lifetime',
    ok: true,
    result:
      method === 'status.get'
        ? {
            capabilities: [
              NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY,
              ...(keyed ? ['notifications.push-route-key.v1'] : [])
            ]
          }
        : { registered: true, unregistered: true, gatewayOrigin: 'https://push.onorca.dev' }
  }))
  return { sendRequest }
}
