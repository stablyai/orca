import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))
const secureStore = vi.hoisted(() => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  ...secureStore
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('./host-credential-cleanup', () => ({
  cancelPendingHostCredentialCleanup: vi.fn(async () => undefined),
  recordHostCredentialCleanupIntent: vi.fn(async () => undefined),
  scheduleHostCredentialCleanup: vi.fn(async () => undefined),
  retryPendingHostCredentialCleanups: vi.fn()
}))

import { loadHostCatalog, resetHostStoreForTests, saveHost } from './host-store'
import { subscribeHostCollectionChanges } from './host-collection-changes'
import { resetMobileRelayHostOverlayStoreForTests } from './mobile-relay-host-overlay-store'

const HOSTS_STORAGE_KEY = 'orca:hosts'
const HOST = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  publicKeyB64: 'key-1',
  lastConnected: 0
}

describe('host store collection notifications', () => {
  let storedHosts: Array<typeof HOST>
  let credentialByHostId: Map<string, string>

  beforeEach(() => {
    vi.clearAllMocks()
    resetHostStoreForTests()
    resetMobileRelayHostOverlayStoreForTests()
    storedHosts = [HOST]
    credentialByHostId = new Map()
    asyncStorage.getItem.mockImplementation(async (key: string) =>
      key === HOSTS_STORAGE_KEY ? JSON.stringify(storedHosts) : null
    )
    asyncStorage.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        storedHosts = JSON.parse(raw)
      }
    })
    secureStore.getItemAsync.mockImplementation(async (key: string) => {
      const hostId = [...credentialByHostId.keys()].find((id) => key.endsWith(id))
      return hostId ? (credentialByHostId.get(hostId) ?? null) : null
    })
    secureStore.setItemAsync.mockImplementation(async (key: string, token: string) => {
      const hostId = key.split('.').at(-1)
      if (hostId) {
        credentialByHostId.set(hostId, token)
      }
    })
  })

  it('announces new membership and restored credentials', async () => {
    await loadHostCatalog()
    const listener = vi.fn()
    subscribeHostCollectionChanges(listener)

    await saveHost({ ...HOST, deviceToken: 'restored-token' })
    await saveHost({
      ...HOST,
      id: 'host-2',
      name: 'Host 2',
      publicKeyB64: 'key-2',
      deviceToken: 'new-token'
    })

    expect(listener).toHaveBeenNthCalledWith(1, { retiredHostIds: [] })
    expect(listener).toHaveBeenNthCalledWith(2, { retiredHostIds: [] })
  })

  it('announces duplicate identities retired by an authoritative save', async () => {
    storedHosts = [HOST, { ...HOST, id: 'host-duplicate', name: 'Duplicate' }]
    const listener = vi.fn()
    subscribeHostCollectionChanges(listener)

    await saveHost({ ...HOST, deviceToken: 'replacement-token' })

    expect(listener).toHaveBeenCalledWith({ retiredHostIds: ['host-duplicate'] })
  })
})
