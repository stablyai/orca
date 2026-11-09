import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock
}))

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  ...secureStoreMock
}))

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' }
}))

vi.mock('./host-credential-cleanup', () => ({
  cancelPendingHostCredentialCleanup: vi.fn().mockResolvedValue(undefined),
  recordHostCredentialCleanupIntent: vi.fn().mockResolvedValue(undefined),
  scheduleHostCredentialCleanup: vi.fn().mockResolvedValue(undefined),
  retryPendingHostCredentialCleanups: vi.fn()
}))

import {
  loadHosts,
  resetHostStoreForTests,
  savePairedHost,
  updateHostNameAndEndpoint
} from './host-store'
import { updateHostDescriptor } from './host-descriptor-persistence'
import { resetMobileRelayHostOverlayStoreForTests } from './mobile-relay-host-overlay-store'
import { StoredHostProfileSchema, type StoredHostProfile } from './host-profile'

const HOSTS_STORAGE_KEY = 'orca:hosts'

const GENERATED_HOST = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  publicKeyB64: 'key-1',
  lastConnected: 0
}

const TYPED_HOST = {
  id: 'host-2',
  name: 'Windows-Low Spec',
  endpoint: 'ws://127.0.0.1:2',
  publicKeyB64: 'key-2',
  lastConnected: 0
}

describe('host name identity', () => {
  let storedHostsRaw: string

  beforeEach(() => {
    vi.clearAllMocks()
    resetHostStoreForTests()
    resetMobileRelayHostOverlayStoreForTests()
    storedHostsRaw = JSON.stringify([GENERATED_HOST, TYPED_HOST])
    asyncStorageMock.getItem.mockImplementation(async (key: string) =>
      key === HOSTS_STORAGE_KEY ? storedHostsRaw : null
    )
    asyncStorageMock.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        storedHostsRaw = raw
      }
    })
    secureStoreMock.setItemAsync.mockResolvedValue(undefined)
    secureStoreMock.getItemAsync.mockResolvedValue('device-token')
  })

  function stored(): StoredHostProfile[] {
    return StoredHostProfileSchema.array().parse(JSON.parse(storedHostsRaw))
  }

  describe('legacy classification', () => {
    it('does not re-classify an adopted machine name once identity fields exist', async () => {
      // A record the descriptor writer already touched: non-generated name, no override.
      storedHostsRaw = JSON.stringify([
        {
          ...GENERATED_HOST,
          name: 'm4airs-Air',
          lastKnownMachineName: 'm4airs-Air',
          lastKnownHostPlatform: 'darwin'
        }
      ])
      const hosts = await loadHosts()
      expect(hosts[0]?.personalName).toBeUndefined()
    })

    it('drops only an identity value this build cannot read, never the paired host', async () => {
      // A newer build's platform, or an empty string, as a rolled-back app would find them.
      storedHostsRaw = JSON.stringify([
        { ...GENERATED_HOST, lastKnownHostPlatform: 'plan9', lastKnownMachineName: 'Studio' },
        { ...TYPED_HOST, personalName: '', lastKnownMachineName: '' }
      ])
      const loaded = await loadHosts()
      expect(loaded.map(({ id }) => id)).toEqual([GENERATED_HOST.id, TYPED_HOST.id])
      expect(loaded[0]?.lastKnownHostPlatform).toBeUndefined()
      expect(loaded[0]?.lastKnownMachineName).toBe('Studio')
      // The next write persists the list it parsed, so a dropped record would be gone for good.
      await updateHostNameAndEndpoint(TYPED_HOST.id, { endpoint: 'ws://10.0.0.9:6768' })
      const records: Record<string, unknown>[] = JSON.parse(storedHostsRaw)
      expect(records.map(({ id }) => id)).toEqual([GENERATED_HOST.id, TYPED_HOST.id])
      expect(records[0]).not.toHaveProperty('lastKnownHostPlatform')
      expect(records[1]).not.toHaveProperty('lastKnownMachineName')
      expect(records[1]?.personalName).toBe('Windows-Low Spec')
    })
  })

  describe('updateHostDescriptor', () => {
    it('clears a stale machine name when a live host stops reporting one', async () => {
      await updateHostDescriptor(GENERATED_HOST.id, {
        machineName: 'm4airs-Air',
        platform: 'darwin'
      })
      await updateHostDescriptor(GENERATED_HOST.id, { machineName: null, platform: 'darwin' })
      const record = stored().find(({ id }) => id === GENERATED_HOST.id)
      expect(record?.lastKnownMachineName).toBeUndefined()
      expect(record?.name).toBe('m4airs-Air')
    })
  })

  describe('re-pair', () => {
    it('preserves the override and descriptor a pairing save knows nothing about', async () => {
      await updateHostDescriptor(TYPED_HOST.id, { machineName: 'm4airs-Air', platform: 'darwin' })
      await savePairedHost({
        id: TYPED_HOST.id,
        name: 'Windows-Low Spec',
        endpoint: 'ws://10.0.0.9:6768',
        deviceToken: 'fresh-token',
        publicKeyB64: TYPED_HOST.publicKeyB64,
        lastConnected: 99
      })
      expect(stored().find(({ id }) => id === TYPED_HOST.id)).toMatchObject({
        name: 'Windows-Low Spec',
        personalName: 'Windows-Low Spec',
        lastKnownMachineName: 'm4airs-Air',
        lastKnownHostPlatform: 'darwin',
        endpoint: 'ws://10.0.0.9:6768'
      })
    })

    it('does not roll back identity changed since a connection took its profile snapshot', async () => {
      await updateHostDescriptor(TYPED_HOST.id, { machineName: 'Studio', platform: 'darwin' })
      // Use a connection-held snapshot to prove saves cannot roll back later identity changes.
      const snapshot = (await loadHosts()).find(({ id }) => id === TYPED_HOST.id)!
      await updateHostNameAndEndpoint(TYPED_HOST.id, { personalName: null })
      await updateHostDescriptor(TYPED_HOST.id, { machineName: 'Studio 2', platform: 'darwin' })
      await savePairedHost({ ...snapshot, lastConnected: 99 })
      const record = stored().find(({ id }) => id === TYPED_HOST.id)
      expect(record?.personalName).toBeUndefined()
      expect(record).toMatchObject({
        name: 'Studio 2',
        lastKnownMachineName: 'Studio 2',
        lastConnected: 99
      })
    })
  })

  describe('phone override edit', () => {
    it('clearing the override returns to the desktop-reported name', async () => {
      await updateHostDescriptor(TYPED_HOST.id, { machineName: 'm4airs-Air', platform: 'darwin' })
      await updateHostNameAndEndpoint(TYPED_HOST.id, { personalName: null })
      const record = stored().find(({ id }) => id === TYPED_HOST.id)
      expect(record?.personalName).toBeUndefined()
      expect(record?.name).toBe('m4airs-Air')
    })
  })
})
