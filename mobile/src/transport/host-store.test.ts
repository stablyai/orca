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
  scheduleHostCredentialCleanup: (...args: unknown[]) => scheduleCleanupMock(...args),
  retryPendingHostCredentialCleanups: vi.fn()
}))

import {
  loadHosts,
  MobileRelayUpgradeHostRemovedError,
  removeHost,
  renameHost,
  resetHostStoreForTests,
  saveExistingHostRelayUpgrade,
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

describe('host-store list mutations', () => {
  let storedHostsRaw: string
  let storedOverlayRaw: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetHostStoreForTests()
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
      }
    })
    secureStoreMock.getItemAsync.mockImplementation(async (key: string) =>
      key.endsWith(HOST_ONE.id) || key.endsWith(HOST_TWO.id) ? `token-${key.at(-1)}` : null
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

    const rename = renameHost(HOST_ONE.id, 'Renamed Host')
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
      renameHost(HOST_ONE.id, 'Alpha'),
      updateLastConnected(HOST_ONE.id),
      renameHost(HOST_TWO.id, 'Beta')
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
    await expect(renameHost(HOST_ONE.id, 'Nope')).rejects.toThrow(/unreadable/)
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
    expect(storedHostsRaw).toBe('{')
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
