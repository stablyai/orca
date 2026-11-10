import { beforeEach, describe, expect, it, vi } from 'vitest'
import './mobile-relay-host-overlay'

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

const secureStoreMock = vi.hoisted(() => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn()
}))

const scheduleCleanupMock = vi.hoisted(() => vi.fn())
const cancelCleanupMock = vi.hoisted(() => vi.fn())
const recordCleanupIntentMock = vi.hoisted(() => vi.fn())
const platformMock = vi.hoisted(() => ({ OS: 'ios' }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock
}))

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  ...secureStoreMock
}))

vi.mock('react-native', () => ({
  Platform: platformMock
}))

vi.mock('../host-credentials/host-credential-cleanup', () => ({
  cancelPendingHostCredentialCleanup: (...args: unknown[]) => cancelCleanupMock(...args),
  recordHostCredentialCleanupIntent: (...args: unknown[]) => recordCleanupIntentMock(...args),
  scheduleHostCredentialCleanup: (...args: unknown[]) => scheduleCleanupMock(...args),
  retryPendingHostCredentialCleanups: vi.fn()
}))

import { loadHostCatalog, loadHosts, resetHostStoreForTests, savePairedHost } from './host-store'
import { resetMobileRelayHostOverlayStoreForTests } from './mobile-relay-host-overlay-store'

const HOSTS_STORAGE_KEY = 'orca:hosts'
const OVERLAY_STORAGE_KEY = 'orca:mobile-relay:host-overlays:v2'
const HOST_ONE = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  publicKeyB64: 'key',
  lastConnected: 0
}
const HOST_TWO = {
  id: 'host-2',
  name: 'Host 2',
  endpoint: 'ws://127.0.0.1:2',
  publicKeyB64: 'key-2',
  lastConnected: 0
}

describe('host-store list mutations', () => {
  let storedHostsRaw: string
  let storedOverlayRaw: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetHostStoreForTests()
    platformMock.OS = 'ios'
    resetMobileRelayHostOverlayStoreForTests()
    scheduleCleanupMock.mockReset()
    scheduleCleanupMock.mockResolvedValue(undefined)
    cancelCleanupMock.mockReset()
    cancelCleanupMock.mockResolvedValue(undefined)
    recordCleanupIntentMock.mockReset()
    recordCleanupIntentMock.mockResolvedValue(undefined)
    storedHostsRaw = JSON.stringify([HOST_ONE, HOST_TWO])
    storedOverlayRaw = null
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        return storedHostsRaw
      }
      if (key === OVERLAY_STORAGE_KEY) {
        return storedOverlayRaw
      }
      return null
    })
    asyncStorageMock.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        storedHostsRaw = raw
      } else if (key === OVERLAY_STORAGE_KEY) {
        storedOverlayRaw = raw
      }
    })
    secureStoreMock.setItemAsync.mockResolvedValue(undefined)
    secureStoreMock.getItemAsync.mockImplementation(async (key: string) =>
      key.endsWith(HOST_ONE.id) || key.endsWith(HOST_TWO.id) ? `token-${key.at(-1)}` : null
    )
  })

  it('keeps a host visible when its credential read temporarily fails', async () => {
    secureStoreMock.getItemAsync.mockImplementation(async (key: string) => {
      if (key.endsWith(HOST_ONE.id)) {
        throw new Error('keychain locked')
      }
      return key.endsWith(HOST_TWO.id) ? 'token-2' : null
    })

    const catalog = await loadHostCatalog()
    const profiles = await loadHosts()

    expect(catalog.map(({ id }) => id)).toEqual([HOST_ONE.id, HOST_TWO.id])
    expect(catalog.find(({ id }) => id === HOST_ONE.id)).toMatchObject({
      credentialStatus: 'temporarily-unavailable',
      profile: null
    })
    expect(profiles.map(({ id }) => id)).toEqual([HOST_TWO.id])
  })

  it('serves a committed replacement token when same-key metadata persistence fails', async () => {
    const duplicate = {
      ...HOST_TWO,
      id: 'host-duplicate',
      publicKeyB64: HOST_ONE.publicKeyB64
    }
    storedHostsRaw = JSON.stringify([HOST_ONE, duplicate])
    await loadHosts()
    asyncStorageMock.setItem.mockRejectedValueOnce(new Error('metadata write failed'))

    await expect(
      savePairedHost({
        ...HOST_ONE,
        endpoint: 'ws://127.0.0.1:3',
        deviceToken: 'replacement-token'
      })
    ).rejects.toThrow('metadata write failed')

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_ONE, duplicate])
    await expect(
      loadHosts().then((hosts) => hosts.find(({ id }) => id === HOST_ONE.id)?.deviceToken)
    ).resolves.toBe('replacement-token')
  })
})

describe('host-store pairing save after an Android encryption rejection', () => {
  const NEW_HOST = {
    id: 'host-1782629088232',
    name: 'Host 1',
    endpoint: 'ws://192.168.0.56:6769',
    publicKeyB64: 'desktop-key',
    lastConnected: 0,
    deviceToken: 'device-token'
  }
  // Preserve the Android null-message GeneralSecurityException shape from #6600.
  const ENCRYPT_REJECTION = new Error(
    "Could not encrypt the value for key 'orca.host-token.host-1782629088232' under keychain 'key_v1'. Caused by: unknown"
  )
  const GENERATION_KEY = 'orca:pairing-keychain-generation'
  let storedHostsRaw: string
  let storedGenerationRaw: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetHostStoreForTests()
    platformMock.OS = 'android'
    resetMobileRelayHostOverlayStoreForTests()
    scheduleCleanupMock.mockReset()
    scheduleCleanupMock.mockResolvedValue(undefined)
    cancelCleanupMock.mockReset()
    cancelCleanupMock.mockResolvedValue(undefined)
    recordCleanupIntentMock.mockReset()
    recordCleanupIntentMock.mockResolvedValue(undefined)
    storedHostsRaw = '[]'
    storedGenerationRaw = null
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        return storedHostsRaw
      }
      // Retain the durable generation in the mock so reads can follow alias rotation.
      return key === GENERATION_KEY ? storedGenerationRaw : null
    })
    asyncStorageMock.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        storedHostsRaw = raw
      } else if (key === GENERATION_KEY) {
        storedGenerationRaw = raw
      }
    })
    secureStoreMock.deleteItemAsync.mockResolvedValue(undefined)
    secureStoreMock.getItemAsync.mockResolvedValue(null)
  })

  it('serves the rotated token to loadHosts so the saved host survives a relaunch', async () => {
    const written = new Map<string | undefined, string>()
    secureStoreMock.setItemAsync.mockImplementation(
      async (_key: string, value: string, options?: { keychainService?: string }) => {
        if (options?.keychainService === undefined) {
          throw ENCRYPT_REJECTION
        }
        written.set(options.keychainService, value)
      }
    )
    await savePairedHost(NEW_HOST)
    // Clear the process cache to verify durable reads follow the rotated alias.
    resetHostStoreForTests()
    secureStoreMock.getItemAsync.mockImplementation(
      async (_key: string, options?: { keychainService?: string }) =>
        written.get(options?.keychainService) ?? null
    )

    const hosts = await loadHosts()

    expect(hosts).toHaveLength(1)
    expect(hosts[0]!.deviceToken).toBe('device-token')
  })
})
