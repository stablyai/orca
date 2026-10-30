import { vi } from 'vitest'
import type { MobilePushToken } from './push-token'

type Ports = {
  storage: Map<string, string>
  keys: Map<string, string>
  listener?: (token: MobilePushToken) => void
  foreground?: (state: string) => void
  finalFailure?: ReturnType<typeof Promise.withResolvers<void>>
  fault: string
  reads: number
  writes: number
  bytes: number
  native: MobilePushToken
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
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
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
        if (ports.reads === 3) {
          await ports.finalFailure?.promise
        }
        throw new Error('Controlled final catalog failure')
      }
      if (
        (ports.fault === 'catalog-read' && key === 'orca:hosts') ||
        (ports.fault === 'version-read' && key === 'orca:push-route-version')
      ) {
        throw new Error('Controlled storage read failure')
      }
      if (ports.fault === 'non-array' && key === 'orca:hosts') {
        return '{}'
      }
      return ports.storage.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      if (key.startsWith('orca:pairing-keychain-')) {
        ports.metadataWrites++
      }
      if (key === 'orca:push-route-version') {
        ports.writes++
        if (ports.fault === 'version-write') {
          throw new Error('Controlled storage write failure')
        }
      }
      ports.storage.set(key, value)
    },
    removeItem: async (key: string) => {
      ports.storage.delete(key)
    }
  }
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
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: async () => [],
  dismissNotificationAsync: async () => {}
}))
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: async () => {}
}))
vi.mock('./push-token', () => ({
  getDevicePushToken: async () => ports.native,
  addPushTokenListener: (callback: typeof ports.listener) => {
    ports.listener = callback
    return () => {
      ports.listener = undefined
    }
  }
}))

export function pushOwnerNativePorts(): Ports {
  return ports
}
