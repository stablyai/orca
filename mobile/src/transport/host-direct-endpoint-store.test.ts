import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DirectEndpointHostRemovedError,
  saveRefreshedDirectEndpoint
} from './host-direct-endpoint-store'
import { removeHost, resetHostStoreForTests } from './host-store'
import { toStoredMobileRelayHostOverlay } from './mobile-relay-host-overlay'
import { resetMobileRelayHostOverlayStoreForTests } from './mobile-relay-host-overlay-store'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn()
  }
}))

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'
}))

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' }
}))

vi.mock('./host-credential-cleanup', () => ({
  cancelPendingHostCredentialCleanup: vi.fn(async () => {}),
  recordHostCredentialCleanupIntent: vi.fn(async () => {}),
  scheduleHostCredentialCleanup: vi.fn(async () => {}),
  retryPendingHostCredentialCleanups: vi.fn()
}))

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

describe('saveRefreshedDirectEndpoint', () => {
  let storedHostsRaw: string
  let storedOverlayRaw: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetHostStoreForTests()
    resetMobileRelayHostOverlayStoreForTests()
    storedHostsRaw = JSON.stringify([HOST_ONE, HOST_TWO])
    storedOverlayRaw = null
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        return storedHostsRaw
      }
      if (key === OVERLAY_STORAGE_KEY) {
        return storedOverlayRaw
      }
      return null
    })
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key: string, raw: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        storedHostsRaw = raw
      } else if (key === OVERLAY_STORAGE_KEY) {
        storedOverlayRaw = raw
      }
    })
    vi.mocked(SecureStore.setItemAsync).mockResolvedValue(undefined)
  })

  it('updates a refreshed direct endpoint without rewriting the token or relay overlay', async () => {
    const overlay = toStoredMobileRelayHostOverlay(HOST_ONE.id, HOST_ONE_RELAY)
    storedOverlayRaw = JSON.stringify([overlay])
    const refreshed = 'ws://192.168.1.50:6768'

    await saveRefreshedDirectEndpoint({
      ...HOST_ONE,
      deviceToken: 'token-1',
      endpoint: refreshed,
      relay: HOST_ONE_RELAY
    })

    expect(JSON.parse(storedHostsRaw)).toEqual([{ ...HOST_ONE, endpoint: refreshed }, HOST_TWO])
    expect(JSON.parse(storedOverlayRaw!)).toEqual([overlay])
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  })

  it('does not let an in-flight direct refresh recreate a removed host', async () => {
    let releaseHostsWrite: (() => void) | null = null
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key: string, raw: string) => {
      if (key === HOSTS_STORAGE_KEY && releaseHostsWrite === null) {
        await new Promise<void>((resolve) => {
          releaseHostsWrite = resolve
        })
      }
      if (key === HOSTS_STORAGE_KEY) {
        storedHostsRaw = raw
      } else if (key === OVERLAY_STORAGE_KEY) {
        storedOverlayRaw = raw
      }
    })

    const removal = removeHost(HOST_ONE.id)
    await vi.waitFor(() => expect(releaseHostsWrite).toBeTypeOf('function'))
    const refresh = saveRefreshedDirectEndpoint({
      ...HOST_ONE,
      deviceToken: 'token-1',
      endpoint: 'ws://192.168.1.50:6768',
      relay: HOST_ONE_RELAY
    })
    releaseHostsWrite?.()
    await removal

    await expect(refresh).rejects.toBeInstanceOf(DirectEndpointHostRemovedError)
    expect(JSON.parse(storedHostsRaw).map(({ id }: { id: string }) => id)).toEqual([HOST_TWO.id])
    expect(storedOverlayRaw).toBeNull()
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  })
})
