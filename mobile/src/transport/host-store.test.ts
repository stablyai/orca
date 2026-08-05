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
  scheduleHostCredentialCleanup: (...args: unknown[]) => scheduleCleanupMock(...args),
  retryPendingHostCredentialCleanups: vi.fn()
}))

import {
  loadHosts,
  removeHost,
  resolvePairingHostIdentity,
  resetHostStoreForTests,
  saveHost,
  updateHostNameAndEndpoint,
  updateLastConnected
} from './host-store'
import {
  MobileRelayUpgradeLifecycleRetiredError,
  MobileRelayUpgradeHostRemovedError,
  MobileRelayUpgradeHostSupersededError,
  saveExistingHostRelayRouting,
  writeExistingHostRelayCredentialBundle
} from './existing-host-relay-routing'
import { resetMobileRelayHostOverlayStoreForTests } from './mobile-relay-host-overlay-store'
import { publishHostProfileTransaction } from './host-profile-publication'

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
    expect(scheduleCleanupMock).toHaveBeenCalledWith('host-duplicate', expect.any(Function))
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

  it('merges v2 endpoints only onto an existing legacy base host', async () => {
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

    const hosts = await loadHosts()

    expect(hosts.find(({ id }) => id === HOST_ONE.id)).toMatchObject({
      endpoints: overlay.endpoints,
      relayHostId: overlay.relayHostId,
      relay: overlay.relay
    })
    expect(hosts.some(({ id }) => id === 'removed-by-old-build')).toBe(false)
  })

  it('refuses to resurrect a removed host during relay upgrade publication', async () => {
    storedHostsRaw = JSON.stringify([HOST_TWO])

    await expect(
      saveExistingHostRelayRouting({ ...HOST_ONE, deviceToken: 'token-1' })
    ).rejects.toBeInstanceOf(MobileRelayUpgradeHostRemovedError)

    expect(JSON.parse(storedHostsRaw)).toEqual([HOST_TWO])
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
  })

  it('does not treat a transient credential read failure as durable host removal', async () => {
    secureStoreMock.getItemAsync.mockRejectedValueOnce(new Error('keychain locked'))

    const error = await saveExistingHostRelayRouting({
      ...HOST_ONE,
      deviceToken: 'token-1',
      endpoints: [{ id: 'direct-primary', kind: 'lan', url: HOST_ONE.endpoint }],
      relayHostId: 'AbCdEf0123_-xyZ9',
      relay: {
        v: 1,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay.onorca.dev',
        assignmentEpoch: 1,
        relayHostId: 'AbCdEf0123_-xyZ9',
        e2eeFraming: 2
      }
    }).catch((reason: unknown) => reason)

    expect(error).toMatchObject({ message: 'keychain locked' })
    expect(error).not.toBeInstanceOf(MobileRelayUpgradeHostRemovedError)
    expect(storedOverlayRaw).toBeNull()
  })

  it('validates only the target credential during relay publication', async () => {
    secureStoreMock.getItemAsync.mockImplementation(async (key: string) =>
      key.endsWith(HOST_ONE.id) ? 'token-1' : null
    )
    const relayHostId = 'AbCdEf0123_-xyZ9'

    await saveExistingHostRelayRouting({
      ...HOST_ONE,
      deviceToken: 'token-1',
      endpoints: [
        { id: 'direct-primary', kind: 'lan', url: HOST_ONE.endpoint },
        { id: 'relay-primary', kind: 'relay', url: 'wss://relay.onorca.dev/v1/connect/host' }
      ],
      relayHostId,
      relay: {
        v: 1,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay.onorca.dev',
        assignmentEpoch: 1,
        relayHostId,
        e2eeFraming: 2
      }
    })
    expect(secureStoreMock.getItemAsync).toHaveBeenCalledOnce()
    expect(secureStoreMock.getItemAsync.mock.calls[0]?.[0]).toContain(HOST_ONE.id)
    expect(JSON.parse(storedOverlayRaw ?? '[]')).toHaveLength(1)
  })

  it('does not infer host removal from unreadable identity storage', async () => {
    storedHostsRaw = '{'

    const error = await saveExistingHostRelayRouting({
      ...HOST_ONE,
      deviceToken: 'token-1'
    }).catch((reason: unknown) => reason)

    expect(error).toMatchObject({ message: 'host list storage unreadable' })
    expect(error).not.toBeInstanceOf(MobileRelayUpgradeHostRemovedError)
    expect(storedOverlayRaw).toBeNull()
    expect(secureStoreMock.getItemAsync).not.toHaveBeenCalled()
  })

  it('publishes relay routing without overwriting a newer endpoint edit', async () => {
    const relayHostId = 'AbCdEf0123_-xyZ9'
    await updateHostNameAndEndpoint(HOST_ONE.id, { endpoint: 'ws://127.0.0.1:9' })

    await saveExistingHostRelayRouting({
      ...HOST_ONE,
      deviceToken: 'token-1',
      endpoints: [
        { id: 'direct-primary', kind: 'lan', url: HOST_ONE.endpoint },
        { id: 'relay-primary', kind: 'relay', url: 'wss://relay.onorca.dev/v1/connect/host' }
      ],
      relayHostId,
      relay: {
        v: 1,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay.onorca.dev',
        assignmentEpoch: 1,
        relayHostId,
        e2eeFraming: 2
      }
    })

    expect(JSON.parse(storedHostsRaw)).toContainEqual(
      expect.objectContaining({ id: HOST_ONE.id, endpoint: 'ws://127.0.0.1:9' })
    )
    expect(JSON.parse(storedOverlayRaw ?? '[]')).toContainEqual(
      expect.objectContaining({
        hostId: HOST_ONE.id,
        relayHostId,
        endpoints: expect.arrayContaining([
          expect.objectContaining({
            id: 'direct-primary',
            url: 'ws://127.0.0.1:9'
          })
        ])
      })
    )
  })

  it('updates relay overlay routing when the primary host address changes later', async () => {
    const overlay: MobileRelayHostOverlay = {
      v: 2,
      hostId: HOST_ONE.id,
      endpoints: [
        { id: 'direct-primary', kind: 'lan', url: HOST_ONE.endpoint },
        { id: 'tailscale-backup', kind: 'tailscale', url: 'ws://desk.example.ts.net:6768' },
        { id: 'relay-primary', kind: 'relay', url: 'wss://relay.onorca.dev/v1/connect/host' }
      ],
      relayHostId: 'AbCdEf0123_-xyZ9',
      relay: {
        v: 1,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay.onorca.dev',
        assignmentEpoch: 1,
        relayHostId: 'AbCdEf0123_-xyZ9',
        e2eeFraming: 2
      }
    }
    storedOverlayRaw = JSON.stringify([overlay])

    await updateHostNameAndEndpoint(HOST_ONE.id, { endpoint: 'ws://127.0.0.1:9' })

    const [updated] = JSON.parse(storedOverlayRaw ?? '[]') as MobileRelayHostOverlay[]
    expect(updated?.endpoints).toContainEqual({
      id: 'direct-primary',
      kind: 'lan',
      url: 'ws://127.0.0.1:9'
    })
    expect(updated?.endpoints).toContainEqual(overlay.endpoints[1])
  })

  it('rejects relay routing from a lifecycle superseded by same-host re-pairing', async () => {
    await saveHost({ ...HOST_ONE, deviceToken: 'replacement-token' })
    secureStoreMock.getItemAsync.mockResolvedValueOnce('replacement-token')
    const relayHostId = 'AbCdEf0123_-xyZ9'

    await expect(
      saveExistingHostRelayRouting({
        ...HOST_ONE,
        deviceToken: 'token-1',
        endpoints: [
          { id: 'direct-primary', kind: 'lan', url: HOST_ONE.endpoint },
          { id: 'relay-primary', kind: 'relay', url: 'wss://relay.onorca.dev/v1/connect/host' }
        ],
        relayHostId,
        relay: {
          v: 1,
          directorUrl: 'https://relay.onorca.dev',
          cellUrl: 'https://relay.onorca.dev',
          assignmentEpoch: 1,
          relayHostId,
          e2eeFraming: 2
        }
      })
    ).rejects.toBeInstanceOf(MobileRelayUpgradeHostSupersededError)

    expect(JSON.parse(storedOverlayRaw ?? '[]')).toEqual([])
  })

  it('does not let a stalled identity read block same-host endpoint edits', async () => {
    let releaseOldToken: ((token: string | null) => void) | null = null
    secureStoreMock.getItemAsync.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          releaseOldToken = resolve
        })
    )
    const stalePublication = saveExistingHostRelayRouting({
      ...HOST_ONE,
      deviceToken: 'token-1',
      endpoints: [
        { id: 'direct-primary', kind: 'lan', url: HOST_ONE.endpoint },
        { id: 'relay-primary', kind: 'relay', url: 'wss://relay.onorca.dev/v1/connect/host' }
      ],
      relayHostId: 'AbCdEf0123_-xyZ9',
      relay: {
        v: 1,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay.onorca.dev',
        assignmentEpoch: 1,
        relayHostId: 'AbCdEf0123_-xyZ9',
        e2eeFraming: 2
      }
    })
    await vi.waitFor(() => expect(secureStoreMock.getItemAsync).toHaveBeenCalledOnce())

    await expect(
      updateHostNameAndEndpoint(HOST_ONE.id, {
        name: 'Renamed while Keychain is stalled',
        endpoint: 'ws://127.0.0.1:9'
      })
    ).resolves.toBeUndefined()
    expect(JSON.parse(storedHostsRaw)).toContainEqual({
      ...HOST_ONE,
      name: 'Renamed while Keychain is stalled',
      endpoint: 'ws://127.0.0.1:9'
    })

    releaseOldToken?.('token-1')
    await expect(stalePublication).rejects.toBeInstanceOf(MobileRelayUpgradeLifecycleRetiredError)
    expect(JSON.parse(storedOverlayRaw ?? '[]')).toEqual([])
  })

  it('lets same-host re-pair supersede a publication stalled on identity lookup', async () => {
    let releaseOldToken: ((token: string | null) => void) | null = null
    secureStoreMock.getItemAsync
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            releaseOldToken = resolve
          })
      )
      .mockResolvedValue('replacement-token')
    const stalePublication = saveExistingHostRelayRouting({
      ...HOST_ONE,
      deviceToken: 'token-1',
      endpoints: [
        { id: 'direct-primary', kind: 'lan', url: HOST_ONE.endpoint },
        { id: 'relay-primary', kind: 'relay', url: 'wss://relay.onorca.dev/v1/connect/host' }
      ],
      relayHostId: 'AbCdEf0123_-xyZ9',
      relay: {
        v: 1,
        directorUrl: 'https://relay.onorca.dev',
        cellUrl: 'https://relay.onorca.dev',
        assignmentEpoch: 1,
        relayHostId: 'AbCdEf0123_-xyZ9',
        e2eeFraming: 2
      }
    })
    await vi.waitFor(() => expect(secureStoreMock.getItemAsync).toHaveBeenCalledOnce())

    const replacement = publishHostProfileTransaction(
      { ...HOST_ONE, deviceToken: 'replacement-token' },
      null,
      saveHost
    )
    await expect(replacement).resolves.toBeUndefined()

    releaseOldToken?.('token-1')
    await expect(stalePublication).rejects.toBeInstanceOf(MobileRelayUpgradeHostSupersededError)
    expect(JSON.parse(storedOverlayRaw ?? '[]')).toEqual([])
  })

  it('orders an old lifecycle credential write before same-host re-pair credentials', async () => {
    let releaseOldWrite: (() => void) | null = null
    let markOldWriteStarted: (() => void) | null = null
    const oldWritePending = new Promise<void>((resolve) => {
      releaseOldWrite = resolve
    })
    const oldWriteStarted = new Promise<void>((resolve) => {
      markOldWriteStarted = resolve
    })
    const writes: string[] = []
    const oldWrite = writeExistingHostRelayCredentialBundle(
      { ...HOST_ONE, deviceToken: 'token-1' },
      {
        v: 1,
        hostId: HOST_ONE.id,
        deviceToken: 'token-1',
        current: {
          token: 'A'.repeat(43),
          hash: 'B'.repeat(43),
          version: 1,
          expiresAt: 1
        }
      },
      async () => {
        markOldWriteStarted?.()
        await oldWritePending
        writes.push('old')
      }
    )
    await oldWriteStarted

    const replacement = publishHostProfileTransaction(
      { ...HOST_ONE, deviceToken: 'replacement-token' },
      async () => {
        writes.push('replacement')
      },
      saveHost
    )
    await Promise.resolve()
    expect(writes).toEqual([])

    releaseOldWrite?.()
    await Promise.all([oldWrite, replacement])
    expect(writes).toEqual(['old', 'replacement'])
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
    expect(scheduleCleanupMock).toHaveBeenCalledOnce()

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
