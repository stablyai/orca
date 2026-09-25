import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadHosts,
  MobileRelayUpgradeHostRemovedError,
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

describe('updateHostNameAndEndpoint', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  const stored = [
    {
      id: 'host-1',
      name: 'Desk',
      endpoint: 'ws://100.64.0.5:6768',
      publicKeyB64: 'pk',
      lastConnected: 1
    },
    {
      id: 'host-2',
      name: 'Laptop',
      endpoint: 'wss://laptop.example:8443',
      publicKeyB64: 'pk-2',
      lastConnected: 2
    }
  ]

  // Legacy typed names parse as phone overrides, so the untouched row keeps its override too.
  const legacyOverride = (host: (typeof stored)[number]) => ({ ...host, personalName: host.name })

  function writtenHosts(): unknown {
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1)
    const [key, value] = vi.mocked(AsyncStorage.setItem).mock.calls[0]!
    expect(key).toBe('orca:hosts')
    return JSON.parse(value)
  }

  it('commits the phone name and endpoint together in a single write', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(stored))

    await updateHostNameAndEndpoint('host-1', {
      personalName: 'Home Desk',
      endpoint: 'ws://192.168.1.10:6768'
    })

    expect(writtenHosts()).toEqual([
      {
        ...stored[0],
        name: 'Home Desk',
        personalName: 'Home Desk',
        endpoint: 'ws://192.168.1.10:6768'
      },
      legacyOverride(stored[1]!)
    ])
  })

  it('updates only the provided field', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(stored))

    await updateHostNameAndEndpoint('host-1', { personalName: 'Home Desk' })

    expect(writtenHosts()).toEqual([
      { ...stored[0], name: 'Home Desk', personalName: 'Home Desk' },
      legacyOverride(stored[1]!)
    ])
  })

  it('rewrites only the endpoint when the name is omitted', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(stored))

    await updateHostNameAndEndpoint('host-1', { endpoint: 'ws://192.168.1.10:6768' })

    expect(writtenHosts()).toEqual([
      { ...legacyOverride(stored[0]!), endpoint: 'ws://192.168.1.10:6768' },
      legacyOverride(stored[1]!)
    ])
  })

  it('throws and writes nothing when the host is missing', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('[]')

    await expect(updateHostNameAndEndpoint('missing', { personalName: 'Renamed' })).rejects.toThrow(
      'Host not found'
    )
    expect(AsyncStorage.setItem).not.toHaveBeenCalled()
  })
})

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
  const moved = { ...relay, cellUrl: 'https://relay-c2.onorca.dev', assignmentEpoch: 8 }
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

  it('keeps an edited endpoint and the device token when relay routing is learned later', async () => {
    await updateHostNameAndEndpoint('host-1', { personalName: 'Renamed', endpoint: NEW_ENDPOINT })
    const hostsAfterEdit = storage.get('orca:hosts')

    await setRelayRouting('host-1', moved)

    expect(storage.get('orca:hosts')).toBe(hostsAfterEdit)
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
    const [host] = await loadHosts()
    expect(host).toMatchObject({ name: 'Renamed', endpoint: NEW_ENDPOINT, relay: moved })
  })

  it('does not rewrite storage when relay resolution repeats the stored routing', async () => {
    await setRelayRouting('host-1', relay)
    vi.mocked(AsyncStorage.setItem).mockClear()

    await setRelayRouting('host-1', relay)

    expect(AsyncStorage.setItem).not.toHaveBeenCalled()
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  })

  it('refuses to write routing for a removed host and leaves no overlay behind', async () => {
    storage.set('orca:hosts', '[]')
    storage.set(OVERLAY_KEY, '[]')

    await expect(setRelayRouting('host-1', relay)).rejects.toBeInstanceOf(
      MobileRelayUpgradeHostRemovedError
    )

    expect(writesTo(OVERLAY_KEY)).toEqual([])
    expect(writesTo('orca:hosts')).toEqual([])
    await expect(loadHosts()).resolves.toEqual([])
  })

  it('creates routing for a direct-only host being upgraded to relay', async () => {
    storage.set(OVERLAY_KEY, '[]')
    await updateHostNameAndEndpoint('host-1', { endpoint: NEW_ENDPOINT })

    await setRelayRouting('host-1', relay)

    const [host] = await loadHosts()
    expect(host).toMatchObject({ endpoint: NEW_ENDPOINT, relay })
  })
})
