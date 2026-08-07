import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  MobileRelayUpgradeHostRemovedError,
  removeHost,
  resolvePairingHostIdentity,
  resetHostStoreForTests,
  saveHost,
  saveExistingHostRelayUpgrade,
  updateHostNameAndEndpoint,
  updateLastConnected
} from './host-store'
import { resetMobileRelayHostOverlayStoreForTests } from './mobile-relay-host-overlay-store'
import { writeMobileRelayCredentialBundle } from './mobile-relay-credential-bundle'

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
const HOST_ONE_RELAY_BUNDLE = {
  v: 1 as const,
  hostId: HOST_ONE.id,
  deviceToken: 'replacement-token',
  current: {
    token: 'A'.repeat(43),
    hash: 'B'.repeat(43),
    version: 1,
    expiresAt: 10_000
  }
}

function scheduledCleanup(hostId: string): (id: string) => Promise<void> {
  const cleanup = scheduleCleanupMock.mock.calls.find(([id]) => id === hostId)?.[1]
  expect(cleanup).toBeTypeOf('function')
  return cleanup as (id: string) => Promise<void>
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

  it('resolves an existing host by pinned key with one durable read', async () => {
    await expect(resolvePairingHostIdentity(HOST_TWO.publicKeyB64, 'host-new')).resolves.toEqual({
      id: HOST_TWO.id,
      name: HOST_TWO.name
    })
    expect(asyncStorageMock.getItem).toHaveBeenCalledOnce()
  })

  it('names a new host from the same durable read used for identity lookup', async () => {
    await expect(resolvePairingHostIdentity('unpaired-key', 'host-new')).resolves.toEqual({
      id: 'host-new',
      name: 'Host 3'
    })
    expect(asyncStorageMock.getItem).toHaveBeenCalledOnce()
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
    await saveHost({
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

  it('collapses already-persisted duplicates when the desktop is re-paired', async () => {
    storedHostsRaw = JSON.stringify([
      HOST_ONE,
      { ...HOST_TWO, id: 'host-duplicate', publicKeyB64: HOST_ONE.publicKeyB64 }
    ])

    await saveHost({
      ...HOST_ONE,
      endpoint: 'ws://127.0.0.1:3',
      deviceToken: 'replacement-token'
    })

    expect(JSON.parse(storedHostsRaw)).toEqual([{ ...HOST_ONE, endpoint: 'ws://127.0.0.1:3' }])
    expect(recordCleanupIntentMock.mock.invocationCallOrder[0]).toBeLessThan(
      asyncStorageMock.setItem.mock.invocationCallOrder[0]!
    )
    expect(scheduleCleanupMock).toHaveBeenCalledWith('host-duplicate', expect.any(Function))
  })

  it('does not remove same-key metadata when the replacement credential write fails', async () => {
    const duplicate = {
      ...HOST_TWO,
      id: 'host-duplicate',
      publicKeyB64: HOST_ONE.publicKeyB64
    }
    storedHostsRaw = JSON.stringify([HOST_ONE, duplicate])
    secureStoreMock.setItemAsync.mockRejectedValue(new Error('keychain write failed'))

    await expect(
      saveHost({ ...HOST_ONE, endpoint: 'ws://127.0.0.1:3', deviceToken: 'replacement-token' })
    ).rejects.toThrow('keychain write failed')

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_ONE, duplicate])
    expect(cancelCleanupMock).toHaveBeenCalledWith(duplicate.id)
    expect(scheduleCleanupMock).not.toHaveBeenCalled()
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
      saveHost({ ...HOST_ONE, endpoint: 'ws://127.0.0.1:3', deviceToken: 'replacement-token' })
    ).rejects.toThrow('metadata write failed')

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_ONE, duplicate])
    await expect(
      loadHosts().then((hosts) => hosts.find(({ id }) => id === HOST_ONE.id)?.deviceToken)
    ).resolves.toBe('replacement-token')
  })

  it('records cleanup when new same-key metadata fails after its credential commits', async () => {
    const replacement = {
      ...HOST_TWO,
      id: 'host-replacement',
      publicKeyB64: HOST_ONE.publicKeyB64,
      deviceToken: 'replacement-token'
    }
    asyncStorageMock.setItem.mockRejectedValueOnce(new Error('metadata write failed'))

    await expect(saveHost(replacement)).rejects.toThrow('metadata write failed')

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_ONE, HOST_TWO])
    expect(recordCleanupIntentMock).toHaveBeenCalledWith(replacement.id)
    expect(recordCleanupIntentMock.mock.invocationCallOrder[0]).toBeLessThan(
      secureStoreMock.setItemAsync.mock.invocationCallOrder[0]!
    )
    expect(scheduleCleanupMock).toHaveBeenCalledWith(replacement.id, expect.any(Function))
  })

  it('does not clean a duplicate id that a later same-key save made authoritative', async () => {
    const duplicate = {
      ...HOST_TWO,
      id: 'host-duplicate',
      publicKeyB64: HOST_ONE.publicKeyB64
    }
    storedHostsRaw = JSON.stringify([HOST_ONE, duplicate])
    await saveHost({ ...HOST_ONE, deviceToken: 'token-a' })
    const staleCleanup = scheduledCleanup(duplicate.id)

    await saveHost({ ...duplicate, deviceToken: 'token-b' })
    await staleCleanup(duplicate.id)

    expect(JSON.parse(storedHostsRaw)).toEqual([duplicate])
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
  })

  it('does not let stale removal cleanup delete a replacement relay bundle before publication', async () => {
    await removeHost(HOST_ONE.id)
    const staleCleanup = scheduledCleanup(HOST_ONE.id)
    await writeMobileRelayCredentialBundle(HOST_ONE_RELAY_BUNDLE)

    await expect(staleCleanup(HOST_ONE.id)).rejects.toThrow('credential write superseded cleanup')

    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
  })

  it('keeps stale cleanup pending when a replacement relay write fails', async () => {
    await removeHost(HOST_ONE.id)
    const staleCleanup = scheduledCleanup(HOST_ONE.id)
    secureStoreMock.setItemAsync.mockRejectedValueOnce(new Error('keychain write failed'))

    await expect(writeMobileRelayCredentialBundle(HOST_ONE_RELAY_BUNDLE)).rejects.toThrow(
      'keychain write failed'
    )
    await expect(staleCleanup(HOST_ONE.id)).rejects.toThrow('credential write superseded cleanup')

    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
  })

  it('stops stale cleanup when a replacement relay write starts during token deletion', async () => {
    await removeHost(HOST_ONE.id)
    const staleCleanup = scheduledCleanup(HOST_ONE.id)
    let releaseTokenDelete: () => void = () => {}
    secureStoreMock.deleteItemAsync.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseTokenDelete = resolve
      })
    )

    const cleanup = staleCleanup(HOST_ONE.id)
    await vi.waitFor(() => {
      expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledWith(
        'orca.host-token.host-1',
        expect.anything()
      )
    })
    const bundleWrite = writeMobileRelayCredentialBundle(HOST_ONE_RELAY_BUNDLE)
    releaseTokenDelete()
    await bundleWrite
    await expect(cleanup).rejects.toThrow('credential write superseded cleanup')

    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalledWith(
      'orca.mobile-relay.credentials.host-1',
      expect.anything()
    )
  })

  it('rechecks the write generation immediately before starting credential deletion', async () => {
    await removeHost(HOST_ONE.id)
    const staleCleanup = scheduledCleanup(HOST_ONE.id)
    let resolveCleanupRead: (raw: string) => void = () => {}
    const cleanupRead = new Promise<string>((resolve) => {
      resolveCleanupRead = resolve
    })
    let cleanupReadStarted = false
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === HOSTS_STORAGE_KEY && !cleanupReadStarted) {
        cleanupReadStarted = true
        return cleanupRead
      }
      if (key === HOSTS_STORAGE_KEY) {
        return storedHostsRaw
      }
      if (key === OVERLAY_STORAGE_KEY) {
        return storedOverlayRaw
      }
      return null
    })

    const cleanup = staleCleanup(HOST_ONE.id)
    await vi.waitFor(() => expect(cleanupReadStarted).toBe(true))
    let bundleWrite: Promise<void> | null = null
    resolveCleanupRead(storedHostsRaw)
    queueMicrotask(() => {
      bundleWrite = writeMobileRelayCredentialBundle(HOST_ONE_RELAY_BUNDLE)
    })
    await expect(cleanup).rejects.toThrow('credential write superseded cleanup')
    await vi.waitFor(() => expect(bundleWrite).not.toBeNull())
    await bundleWrite

    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
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
      relayHostId: 'AbCdEf0123_-xyZ9',
      relay: {
        v: 1,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay-c1.onorca.dev',
        assignmentEpoch: 7,
        relayHostId: 'AbCdEf0123_-xyZ9',
        e2eeFraming: 2
      }
    }
    storedOverlayRaw = JSON.stringify([overlay])

    await saveHost({ ...HOST_ONE, deviceToken: 'replacement-token' })

    expect(JSON.parse(storedOverlayRaw!)).toEqual([])
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
  })

  it('does not touch relay storage when saving a new direct-only host', async () => {
    await saveHost({
      id: 'host-new',
      name: 'New Host',
      endpoint: 'ws://127.0.0.1:3',
      publicKeyB64: 'key-new',
      deviceToken: 'new-token',
      lastConnected: 0
    })

    expect(asyncStorageMock.getItem).not.toHaveBeenCalledWith(OVERLAY_STORAGE_KEY)
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
  })

  it('keeps the normal iOS save on the existing default keychain service', async () => {
    await saveHost({
      id: 'host-new',
      name: 'New Host',
      endpoint: 'ws://127.0.0.1:3',
      publicKeyB64: 'key-new',
      deviceToken: 'new-token',
      lastConnected: 0
    })

    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(
      'orca.host-token.host-new',
      'new-token',
      {
        keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'
      }
    )
  })

  it('commits the removal when credential cleanup scheduling rejects', async () => {
    scheduleCleanupMock.mockRejectedValue(new Error('intent storage unavailable'))

    await expect(removeHost(HOST_ONE.id)).resolves.toBeUndefined()

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_TWO])
    expect(scheduleCleanupMock).toHaveBeenCalledWith(HOST_ONE.id, expect.any(Function))
  })

  it('cancels write-ahead cleanup when host metadata removal fails', async () => {
    asyncStorageMock.setItem.mockRejectedValueOnce(new Error('metadata write failed'))

    await expect(removeHost(HOST_ONE.id)).rejects.toThrow('metadata write failed')

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_ONE, HOST_TWO])
    expect(cancelCleanupMock).toHaveBeenCalledWith(HOST_ONE.id)
  })

  it('does not cancel cleanup from a removal committed during a stalled save', async () => {
    let releaseTokenWrite: () => void = () => {}
    secureStoreMock.setItemAsync.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseTokenWrite = resolve
      })
    )

    const save = saveHost({ ...HOST_ONE, deviceToken: 'replacement-token' })
    await vi.waitFor(() => expect(secureStoreMock.setItemAsync).toHaveBeenCalledOnce())
    await removeHost(HOST_ONE.id)
    releaseTokenWrite()
    await save
    await loadHostCatalog()

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_TWO])
    expect(scheduleCleanupMock).toHaveBeenCalledWith(HOST_ONE.id, expect.any(Function))
    expect(cancelCleanupMock).not.toHaveBeenCalled()
  })

  it('refuses an early same-key token write without durable cleanup intent', async () => {
    const replacement = {
      ...HOST_TWO,
      id: 'host-replacement',
      publicKeyB64: HOST_ONE.publicKeyB64,
      deviceToken: 'replacement-token'
    }
    recordCleanupIntentMock.mockRejectedValueOnce(new Error('intent storage unavailable'))

    await expect(saveHost(replacement)).rejects.toThrow('intent storage unavailable')

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_ONE, HOST_TWO])
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
  })

  it('deletes an unpaired credential when cleanup runs without a newer write', async () => {
    await removeHost(HOST_ONE.id)
    const cleanup = scheduledCleanup(HOST_ONE.id)

    await cleanup(HOST_ONE.id)

    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledWith(
      'orca.host-token.host-1',
      expect.anything()
    )
  })

  it('keeps a concurrently re-published orphan overlay authoritative', async () => {
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
      relayHostId: 'AbCdEf0123_-xyZ9',
      relay: {
        v: 1,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay-c1.onorca.dev',
        assignmentEpoch: 7,
        relayHostId: 'AbCdEf0123_-xyZ9',
        e2eeFraming: 2
      }
    }
    storedOverlayRaw = JSON.stringify([overlay, { ...overlay, hostId: 'removed-by-old-build' }])
    let releaseCleanup: () => void = () => {}
    scheduleCleanupMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseCleanup = resolve
      })
    )

    const hostsLoad = loadHosts()
    await vi.waitFor(() => expect(scheduleCleanupMock).toHaveBeenCalled())
    await saveHost({
      ...HOST_ONE,
      id: 'removed-by-old-build',
      publicKeyB64: 'restored-key',
      deviceToken: 'restored-token',
      endpoints: overlay.endpoints,
      relayHostId: overlay.relayHostId,
      relay: overlay.relay
    })
    releaseCleanup()
    const hosts = await hostsLoad

    expect(hosts.find(({ id }) => id === HOST_ONE.id)).toMatchObject({
      endpoints: overlay.endpoints,
      relayHostId: overlay.relayHostId,
      relay: overlay.relay
    })
    expect(hosts.some(({ id }) => id === 'removed-by-old-build')).toBe(false)
    expect(JSON.parse(storedOverlayRaw!)).toContainEqual({
      ...overlay,
      hostId: 'removed-by-old-build'
    })
  })

  it('refuses to resurrect a removed host during relay upgrade publication', async () => {
    storedHostsRaw = JSON.stringify([HOST_TWO])

    await expect(
      saveExistingHostRelayUpgrade({ ...HOST_ONE, deviceToken: 'token-1' })
    ).rejects.toBeInstanceOf(MobileRelayUpgradeHostRemovedError)

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_TWO])
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
  })

  it('awaits cleanup scheduling after metadata commit', async () => {
    let resolveSchedule: (() => void) | null = null
    scheduleCleanupMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSchedule = resolve
      })
    )

    let settled = false
    const removal = removeHost(HOST_ONE.id).then(() => {
      settled = true
    })
    await vi.waitFor(() => {
      expect(JSON.parse(storedHostsRaw)).toEqual([HOST_TWO])
    })
    expect(settled).toBe(false)
    expect(recordCleanupIntentMock.mock.invocationCallOrder[0]).toBeLessThan(
      asyncStorageMock.setItem.mock.invocationCallOrder[0]!
    )

    resolveSchedule?.()
    await removal
    expect(settled).toBe(true)
  })

  it('applies concurrent rename and remove without clobbering either', async () => {
    let releaseReads: (() => void) | null = null
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

    const rename = updateHostNameAndEndpoint(HOST_ONE.id, { name: 'Renamed Host' })
    const remove = removeHost(HOST_TWO.id)
    // Both writers have started their RMW and are blocked on the shared read
    // gate; without a mutation queue the second would clobber the first.
    await vi.waitFor(() => {
      expect(pendingReads).toBeGreaterThanOrEqual(1)
    })
    releaseReads?.()
    await Promise.all([rename, remove])

    expect(JSON.parse(storedHostsRaw)).toEqual([
      {
        ...HOST_ONE,
        name: 'Renamed Host'
      }
    ])
  })

  it('preserves a rename when lastConnected updates race it', async () => {
    const before = Date.now()
    await Promise.all([
      updateHostNameAndEndpoint(HOST_ONE.id, { name: 'Alpha' }),
      updateLastConnected(HOST_ONE.id),
      updateHostNameAndEndpoint(HOST_TWO.id, { name: 'Beta' })
    ])

    const stored = JSON.parse(storedHostsRaw) as Array<typeof HOST_ONE>
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: HOST_ONE.id, name: 'Alpha' }),
        expect.objectContaining({ id: HOST_TWO.id, name: 'Beta' })
      ])
    )
    const hostOne = stored.find((host) => host.id === HOST_ONE.id)
    expect(hostOne?.lastConnected).toBeGreaterThanOrEqual(before)
  })

  it('does not wipe the host list when storage is unreadable during mutation', async () => {
    storedHostsRaw = '{'
    await expect(updateHostNameAndEndpoint(HOST_ONE.id, { name: 'Nope' })).rejects.toThrow(
      /unreadable/
    )
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
    expect(storedHostsRaw).toBe('{')
  })

  // Why: gates the (slow, real-device 50-200ms) Keychain pass so a load can be
  // parked mid-flight while a write commits underneath it.
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

    await updateHostNameAndEndpoint(HOST_ONE.id, { name: 'Living Room Mac' })
    const afterRename = loadHosts()
    releaseKeychain()

    await parkedLoad
    const hosts = await afterRename
    expect(hosts.find((host) => host.id === HOST_ONE.id)?.name).toBe('Living Room Mac')
  })

  it('does not share a host-list pass started before saveHost commits its token', async () => {
    const newHost = {
      id: 'host-new',
      name: 'New Host',
      endpoint: 'ws://127.0.0.1:3',
      publicKeyB64: 'key-new',
      deviceToken: 'token-new',
      lastConnected: 0
    }
    let releaseTokenWrite: () => void = () => {}
    secureStoreMock.setItemAsync.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseTokenWrite = resolve
      })
    )
    let resolveParkedTokenRead: (token: string | null) => void = () => {}
    const parkedTokenRead = new Promise<string | null>((resolve) => {
      resolveParkedTokenRead = resolve
    })
    let shouldParkHostOneRead = true
    secureStoreMock.getItemAsync.mockImplementation(async (key: string) => {
      if (key.endsWith(HOST_ONE.id) && shouldParkHostOneRead) {
        shouldParkHostOneRead = false
        return parkedTokenRead
      }
      if (key.endsWith(newHost.id)) {
        return newHost.deviceToken
      }
      return key.endsWith(HOST_ONE.id) || key.endsWith(HOST_TWO.id) ? `token-${key.at(-1)}` : null
    })

    const save = saveHost(newHost)
    await vi.waitFor(() => {
      expect(secureStoreMock.setItemAsync).toHaveBeenCalled()
    })
    const parkedLoad = loadHosts()
    await vi.waitFor(() => {
      expect(
        asyncStorageMock.getItem.mock.calls.filter(([key]) => key === HOSTS_STORAGE_KEY)
      ).toHaveLength(2)
    })

    releaseTokenWrite()
    await save
    await vi.waitFor(() => {
      expect(secureStoreMock.getItemAsync).toHaveBeenCalledWith(
        expect.stringContaining(HOST_ONE.id),
        expect.anything()
      )
    })
    const afterSave = loadHosts()
    resolveParkedTokenRead(null)

    const [parkedHosts, savedHosts] = await Promise.all([parkedLoad, afterSave])
    expect(savedHosts.map((host) => host.id)).toContain(newHost.id)
    expect(savedHosts).not.toBe(parkedHosts)
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
    await saveHost(newHost)
    resolvePrewriteTokenRead('token-old')
    await parkedLoad

    const hosts = await loadHosts()
    expect(hosts.find((host) => host.id === newHost.id)?.deviceToken).toBe(newHost.deviceToken)
  })

  it('still shares one Keychain pass across loads with no write between them', async () => {
    const releaseKeychain = gateKeychainReads()
    const first = loadHosts()
    await vi.waitFor(() => {
      expect(secureStoreMock.getItemAsync).toHaveBeenCalled()
    })
    const second = loadHosts()
    releaseKeychain()

    const [firstHosts, secondHosts] = await Promise.all([first, second])
    expect(firstHosts).toBe(secondHosts)
    expect(secureStoreMock.getItemAsync).toHaveBeenCalledTimes(2)
  })

  it('resolves instead of rejecting when updateLastConnected hits unreadable storage', async () => {
    // Why: callers fire updateLastConnected with `void`; a rejection here would
    // surface as an unhandled promise rejection rather than a caught error.
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
  // Why: the verbatim Android rejection from #6600 — expo maps a null-message GeneralSecurityException to this.
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
      // Why: the generation record is durable on device; a forgetful mock would fake a broken read path.
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
    // Why: simulate the unverified alias-local case; no affected physical device was available.
    secureStoreMock.setItemAsync.mockImplementation(
      async (_key: string, value: string, options?: { keychainService?: string }) => {
        if (options?.keychainService === undefined) {
          throw ENCRYPT_REJECTION
        }
        written.set(options.keychainService, value)
      }
    )

    await expect(saveHost(NEW_HOST)).resolves.toBeUndefined()

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

    await expect(saveHost(NEW_HOST)).rejects.toBe(ENCRYPT_REJECTION)
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
    await saveHost(NEW_HOST)
    // Why: a fresh process has no token cache, so the host list has to come back off the rotated alias.
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
