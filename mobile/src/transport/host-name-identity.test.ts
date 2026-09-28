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
  updateHostDescriptor,
  updateHostNameAndEndpoint
} from './host-store'
import { resetMobileRelayHostOverlayStoreForTests } from './mobile-relay-host-overlay-store'
import { StoredHostProfileSchema, type StoredHostProfile } from './types'

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
    it('treats a typed legacy name as a phone override and a generated one as none', async () => {
      const hosts = await loadHosts()
      expect(hosts.find(({ id }) => id === GENERATED_HOST.id)?.personalName).toBeUndefined()
      expect(hosts.find(({ id }) => id === TYPED_HOST.id)?.personalName).toBe('Windows-Low Spec')
    })

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
    it('adopts a reported machine name as the display name of an unoverridden host', async () => {
      await updateHostDescriptor(GENERATED_HOST.id, {
        machineName: 'm4airs-Air',
        platform: 'darwin'
      })
      expect(stored().find(({ id }) => id === GENERATED_HOST.id)).toMatchObject({
        name: 'm4airs-Air',
        lastKnownMachineName: 'm4airs-Air',
        lastKnownHostPlatform: 'darwin'
      })
    })

    it('records the descriptor under an override without touching the display name', async () => {
      await updateHostDescriptor(TYPED_HOST.id, { machineName: 'm4airs-Air', platform: 'darwin' })
      expect(stored().find(({ id }) => id === TYPED_HOST.id)).toMatchObject({
        name: 'Windows-Low Spec',
        personalName: 'Windows-Low Spec',
        lastKnownMachineName: 'm4airs-Air'
      })
    })

    it('writes nothing for a desktop that reports neither field', async () => {
      await updateHostDescriptor(GENERATED_HOST.id, { machineName: null, platform: null })
      expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
      expect(stored().find(({ id }) => id === GENERATED_HOST.id)?.name).toBe('Host 1')
    })

    it('clears a stale machine name when a live host stops reporting one', async () => {
      await updateHostDescriptor(GENERATED_HOST.id, {
        machineName: 'm4airs-Air',
        platform: 'darwin'
      })
      await updateHostDescriptor(GENERATED_HOST.id, { machineName: null, platform: 'darwin' })
      const record = stored().find(({ id }) => id === GENERATED_HOST.id)
      expect(record?.lastKnownMachineName).toBeUndefined()
      // The display name is kept: there is nothing better to fall back to.
      expect(record?.name).toBe('m4airs-Air')
    })

    it('swallows unreadable storage instead of surfacing an error', async () => {
      storedHostsRaw = '{'
      await expect(
        updateHostDescriptor(GENERATED_HOST.id, { machineName: 'm4airs-Air', platform: 'darwin' })
      ).resolves.toBeUndefined()
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

    it('re-resolves an adopted name after a re-pair that offered the stored one', async () => {
      await updateHostDescriptor(GENERATED_HOST.id, {
        machineName: 'm4airs-Air',
        platform: 'darwin'
      })
      await savePairedHost({
        id: GENERATED_HOST.id,
        name: 'Host 1',
        endpoint: GENERATED_HOST.endpoint,
        deviceToken: 'fresh-token',
        publicKeyB64: GENERATED_HOST.publicKeyB64,
        lastConnected: 99
      })
      expect(stored().find(({ id }) => id === GENERATED_HOST.id)?.name).toBe('m4airs-Air')
    })

    it('does not roll back identity changed since a connection took its profile snapshot', async () => {
      await updateHostDescriptor(TYPED_HOST.id, { machineName: 'Studio', platform: 'darwin' })
      // A connection holds this for its lifetime; a save built from it must not roll identity back.
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
    it('sets the override and the display name together', async () => {
      await updateHostNameAndEndpoint(GENERATED_HOST.id, { personalName: 'Basement Rig' })
      expect(stored().find(({ id }) => id === GENERATED_HOST.id)).toMatchObject({
        name: 'Basement Rig',
        personalName: 'Basement Rig'
      })
    })

    it('clearing the override returns to the desktop-reported name', async () => {
      await updateHostDescriptor(TYPED_HOST.id, { machineName: 'm4airs-Air', platform: 'darwin' })
      await updateHostNameAndEndpoint(TYPED_HOST.id, { personalName: null })
      const record = stored().find(({ id }) => id === TYPED_HOST.id)
      expect(record?.personalName).toBeUndefined()
      expect(record?.name).toBe('m4airs-Air')
    })

    it('clearing with no known machine name regenerates a Host N name', async () => {
      await updateHostNameAndEndpoint(TYPED_HOST.id, { personalName: null })
      const record = stored().find(({ id }) => id === TYPED_HOST.id)
      expect(record?.personalName).toBeUndefined()
      // "Host 2" is taken by nothing here but "Host 1" exists, so the counter lands on 2.
      expect(record?.name).toBe('Host 2')
    })

    it('keeps an already-generated name when clearing a no-op override', async () => {
      await updateHostNameAndEndpoint(GENERATED_HOST.id, { personalName: null })
      expect(stored().find(({ id }) => id === GENERATED_HOST.id)?.name).toBe('Host 1')
    })
  })
})
