import { beforeEach, describe, expect, it, vi } from 'vitest'
import './mobile-relay-host-overlay'
import type { MobileRelayHostOverlay } from './mobile-relay-host-overlay'

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

vi.mock('./host-credential-cleanup', () => ({
  cancelPendingHostCredentialCleanup: (...args: unknown[]) => cancelCleanupMock(...args),
  recordHostCredentialCleanupIntent: (...args: unknown[]) => recordCleanupIntentMock(...args),
  scheduleHostCredentialCleanup: (...args: unknown[]) => scheduleCleanupMock(...args),
  retryPendingHostCredentialCleanups: vi.fn()
}))

import {
  loadHostCatalog,
  loadHosts,
  RelayRoutingHostRemovedError,
  removeHost,
  resolvePairingHostIdentity,
  resetHostStoreForTests,
  savePairedHost,
  setRelayRouting,
  updateHostNameAndEndpoint,
  updateLastConnected
} from './host-store'
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
const HOST_ONE_RELAY = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
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

  it('keeps orphaned metadata visible when its credential is missing', async () => {
    secureStoreMock.getItemAsync.mockImplementation(async (key: string) =>
      key.endsWith(HOST_TWO.id) ? 'token-2' : null
    )

    const catalog = await loadHostCatalog()

    expect(catalog.find(({ id }) => id === HOST_ONE.id)).toMatchObject({
      credentialStatus: 'missing',
      profile: null
    })
  })

  it('keeps existing metadata when pairing a distinct host', async () => {
    await savePairedHost({
      id: 'host-new',
      name: 'Host 3',
      endpoint: 'ws://127.0.0.1:3',
      publicKeyB64: 'key-new',
      deviceToken: 'token-new',
      lastConnected: 0
    })

    expect(JSON.parse(storedHostsRaw).map(({ id }: { id: string }) => id)).toEqual([
      HOST_ONE.id,
      HOST_TWO.id,
      'host-new'
    ])
  })

  it('fails closed when durable host identity storage is unreadable', async () => {
    asyncStorageMock.getItem.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(resolvePairingHostIdentity('key-new', 'host-new')).rejects.toThrow(/unreadable/)
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
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

  it('clears stale relay state when an existing host is re-paired direct-only', async () => {
    const overlay: MobileRelayHostOverlay = {
      v: 2,
      hostId: HOST_ONE.id,
      endpoints: [
        { id: 'direct-primary', kind: 'lan', url: HOST_ONE.endpoint },
        {
          id: 'relay-primary',
          kind: 'relay',
          url: 'wss://relay-c1.onorca.dev/v1/connect/AbCdEf0123_-xyZ9'
        }
      ],
      relayHostId: HOST_ONE_RELAY.relayHostId,
      relay: HOST_ONE_RELAY
    }
    storedOverlayRaw = JSON.stringify([overlay])

    await savePairedHost({ ...HOST_ONE, deviceToken: 'replacement-token' })

    expect(JSON.parse(storedOverlayRaw!)).toEqual([])
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
  })

  it('refuses an early same-key token write without durable cleanup intent', async () => {
    const replacement = {
      ...HOST_TWO,
      id: 'host-replacement',
      publicKeyB64: HOST_ONE.publicKeyB64,
      deviceToken: 'replacement-token'
    }
    recordCleanupIntentMock.mockRejectedValueOnce(new Error('intent storage unavailable'))

    await expect(savePairedHost(replacement)).rejects.toThrow('intent storage unavailable')

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_ONE, HOST_TWO])
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
  })

  it('refuses to resurrect a removed host during relay upgrade publication', async () => {
    storedHostsRaw = JSON.stringify([HOST_TWO])

    await expect(setRelayRouting(HOST_ONE.id, HOST_ONE_RELAY)).rejects.toBeInstanceOf(
      RelayRoutingHostRemovedError
    )

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_TWO])
    expect(storedOverlayRaw).toBeNull()
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
  })

  it('applies concurrent rename and remove without clobbering either', async () => {
    let releaseReads: (() => void) | undefined
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    let pendingReads = 0
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key !== HOSTS_STORAGE_KEY) {
        return null
      }
      pendingReads += 1
      if (pendingReads <= 2) {
        await readsReleased
      }
      return storedHostsRaw
    })

    const rename = updateHostNameAndEndpoint(HOST_ONE.id, { personalName: 'Renamed Host' })
    const remove = removeHost(HOST_TWO.id)
    // Overlap writers behind one read gate to expose lost updates without serialization.
    await vi.waitFor(() => {
      expect(pendingReads).toBeGreaterThanOrEqual(1)
    })
    releaseReads?.()
    await Promise.all([rename, remove])

    expect(JSON.parse(storedHostsRaw)).toEqual([
      { ...HOST_ONE, name: 'Renamed Host', personalName: 'Renamed Host' }
    ])
  })

  it('does not wipe the host list when storage is unreadable during mutation', async () => {
    storedHostsRaw = '{'
    await expect(updateHostNameAndEndpoint(HOST_ONE.id, { personalName: 'Nope' })).rejects.toThrow(
      /unreadable/
    )
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
    expect(storedHostsRaw).toBe('{')
  })

  // Park the slow keychain pass while a durable write invalidates it.
  function gateKeychainReads(): () => void {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    secureStoreMock.getItemAsync.mockImplementation(async (key: string) => {
      await gate
      return key.endsWith(HOST_ONE.id) || key.endsWith(HOST_TWO.id) ? `token-${key.at(-1)}` : null
    })
    return release
  }

  it('does not serve a pre-removal snapshot to a load issued after the removal (#8791)', async () => {
    const releaseKeychain = gateKeychainReads()
    const parkedLoad = loadHosts()
    await vi.waitFor(() => {
      expect(secureStoreMock.getItemAsync).toHaveBeenCalled()
    })

    await removeHost(HOST_ONE.id)
    const afterRemoval = loadHosts()
    releaseKeychain()

    await parkedLoad
    await expect(afterRemoval.then((hosts) => hosts.map((host) => host.id))).resolves.toEqual([
      HOST_TWO.id
    ])
  })

  it('does not serve a pre-rename snapshot to a load issued after the rename (#8791)', async () => {
    const releaseKeychain = gateKeychainReads()
    const parkedLoad = loadHosts()
    await vi.waitFor(() => {
      expect(secureStoreMock.getItemAsync).toHaveBeenCalled()
    })

    await updateHostNameAndEndpoint(HOST_ONE.id, { personalName: 'Living Room Mac' })
    const afterRename = loadHosts()
    releaseKeychain()

    await parkedLoad
    const hosts = await afterRename
    expect(hosts.find((host) => host.id === HOST_ONE.id)?.name).toBe('Living Room Mac')
  })

  it('does not let a late pre-write token read poison the token cache', async () => {
    const newHost = {
      id: 'host-new',
      name: 'New Host',
      endpoint: 'ws://127.0.0.1:3',
      publicKeyB64: 'key-new',
      deviceToken: 'token-new',
      lastConnected: 0
    }
    storedHostsRaw = JSON.stringify([{ ...newHost, deviceToken: undefined }])
    let resolvePrewriteTokenRead: (token: string) => void = () => {}
    secureStoreMock.getItemAsync.mockReturnValue(
      new Promise<string>((resolve) => {
        resolvePrewriteTokenRead = resolve
      })
    )

    const parkedLoad = loadHosts()
    await vi.waitFor(() => {
      expect(secureStoreMock.getItemAsync).toHaveBeenCalled()
    })
    await savePairedHost(newHost)
    resolvePrewriteTokenRead('token-old')
    await parkedLoad

    const hosts = await loadHosts()
    expect(hosts.find((host) => host.id === newHost.id)?.deviceToken).toBe(newHost.deviceToken)
  })

  it('resolves instead of rejecting when updateLastConnected hits unreadable storage', async () => {
    // Void callers cannot catch rejection; unreadable storage must leave this bookkeeping best-effort.
    storedHostsRaw = '{'
    await expect(updateLastConnected(HOST_ONE.id)).resolves.toBeUndefined()
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
    expect(storedHostsRaw).toBe('{')
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

  it('saves the host when the reported Android failure is alias-local (#6600)', async () => {
    const written = new Map<string | undefined, string>()
    // Model the alias-local hypothesis; no affected physical device was available.
    secureStoreMock.setItemAsync.mockImplementation(
      async (_key: string, value: string, options?: { keychainService?: string }) => {
        if (options?.keychainService === undefined) {
          throw ENCRYPT_REJECTION
        }
        written.set(options.keychainService, value)
      }
    )

    await expect(savePairedHost(NEW_HOST)).resolves.toBeUndefined()

    expect(written.get('orca.pairing.v1')).toBe('device-token')
    expect(JSON.parse(storedHostsRaw)).toEqual([
      {
        id: NEW_HOST.id,
        name: NEW_HOST.name,
        endpoint: NEW_HOST.endpoint,
        publicKeyB64: NEW_HOST.publicKeyB64,
        lastConnected: NEW_HOST.lastConnected
      }
    ])
  })

  it('still surfaces the failure when no keystore alias can accept the token', async () => {
    secureStoreMock.setItemAsync.mockRejectedValue(ENCRYPT_REJECTION)

    await expect(savePairedHost(NEW_HOST)).rejects.toBe(ENCRYPT_REJECTION)
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
