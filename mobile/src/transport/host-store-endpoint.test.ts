import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { updateHostNameAndEndpoint } from './host-store'

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
