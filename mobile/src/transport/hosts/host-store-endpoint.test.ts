import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadHosts,
  RelayRoutingHostRemovedError,
  resetHostStoreForTests,
  setRelayRouting,
  updateHostNameAndEndpoint
} from './host-store'
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

describe('relay routing after a host edit', () => {
  const OVERLAY_KEY = 'orca:mobile-relay:host-overlays:v2'
  const OLD_ENDPOINT = 'ws://192.168.1.10:6768'
  const NEW_ENDPOINT = 'ws://192.168.1.20:6768'
  const relay = {
    v: 1 as const,
    directorUrl: 'https://relay.onorca.dev',
    cellUrl: 'https://relay-c1.onorca.dev',
    assignmentEpoch: 7,
    relayHostId: 'AbCdEf0123_-xyZ9',
    e2eeFraming: 2 as const
  }

  const storage = new Map<string, string>()

  function writesTo(key: string): unknown[] {
    return vi.mocked(AsyncStorage.setItem).mock.calls.filter(([written]) => written === key)
  }

  beforeEach(() => {
    resetHostStoreForTests()
    resetMobileRelayHostOverlayStoreForTests()
    storage.clear()
    storage.set(
      'orca:hosts',
      JSON.stringify([
        { id: 'host-1', name: 'Desk', endpoint: OLD_ENDPOINT, publicKeyB64: 'pk', lastConnected: 1 }
      ])
    )
    // An older build's record: a copy of the row's address beside the relay.
    storage.set(
      OVERLAY_KEY,
      JSON.stringify([
        {
          v: 2,
          hostId: 'host-1',
          endpoints: [
            { id: 'direct-primary', kind: 'lan', url: OLD_ENDPOINT },
            { id: 'relay-primary', kind: 'relay', url: 'wss://relay-c1.onorca.dev/v1/connect/id' }
          ],
          relayHostId: relay.relayHostId,
          relay
        }
      ])
    )
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => storage.get(key) ?? null)
    vi.mocked(AsyncStorage.setItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
      storage.set(key, value)
    })
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue('device-token')
    vi.mocked(SecureStore.setItemAsync).mockReset()
  })

  it('loads only the edited address, whatever an older overlay stored', async () => {
    await updateHostNameAndEndpoint('host-1', { endpoint: NEW_ENDPOINT })

    const [host] = await loadHosts()
    expect(host).toEqual({
      id: 'host-1',
      name: 'Desk',
      personalName: 'Desk',
      endpoint: NEW_ENDPOINT,
      publicKeyB64: 'pk',
      lastConnected: 1,
      deviceToken: 'device-token',
      relay
    })
  })

  it('refuses to write routing for a removed host and leaves no overlay behind', async () => {
    storage.set('orca:hosts', '[]')
    storage.set(OVERLAY_KEY, '[]')

    await expect(setRelayRouting('host-1', relay)).rejects.toBeInstanceOf(
      RelayRoutingHostRemovedError
    )

    expect(writesTo(OVERLAY_KEY)).toEqual([])
    expect(writesTo('orca:hosts')).toEqual([])
    await expect(loadHosts()).resolves.toEqual([])
  })
})
