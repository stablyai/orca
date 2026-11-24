import { beforeEach, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

const state = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  secrets: new Map<string, string>(),
  writes: 0,
  failWrite: 0,
  failDelete: false,
  catalog: [{ id: 'host-a' }],
  nativeActive: new Set<string>(),
  failNativeEnd: false
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => state.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      state.storage.set(key, value)
    },
    removeItem: async (key: string) => {
      state.storage.delete(key)
    }
  }
}))
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => state.secrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    state.writes++
    if (state.writes === state.failWrite) {
      throw new Error('Keychain unavailable')
    }
    state.secrets.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    if (state.failDelete) {
      throw new Error('Keychain unavailable')
    }
    state.secrets.delete(key)
  }
}))
vi.mock('expo-crypto', async () => {
  const { createHash, randomUUID } = await import('node:crypto')
  return {
    randomUUID,
    CryptoDigestAlgorithm: { SHA256: 'sha256' },
    digestStringAsync: async (algorithm: string, input: string) =>
      createHash(algorithm).update(input).digest('hex')
  }
})
vi.mock('./native-live-activities', () => ({
  nativeLiveActivities: {
    environment: async () => 'sandbox',
    storeRoute: async () => {},
    end: async (id: string) => {
      if (state.failNativeEnd) {
        throw new Error('ActivityKit unavailable')
      }
      state.nativeActive.delete(id)
    },
    forgetRoute: async () => {}
  }
}))
vi.mock('../host-catalog/host-store', () => ({ loadHostCatalog: async () => state.catalog }))

export function client(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    subscribe: () => () => {},
    onStateChange: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

beforeEach(() => {
  state.storage.clear()
  state.secrets.clear()
  state.writes = 0
  state.failWrite = 0
  state.failDelete = false
  state.catalog = [{ id: 'host-a' }]
  state.nativeActive.clear()
  state.failNativeEnd = false
})

export const backend = state
