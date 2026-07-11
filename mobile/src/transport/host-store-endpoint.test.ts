import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { updateHostEndpoint } from './host-store'

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

describe('updateHostEndpoint', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  it('rewrites only the endpoint for the matching host', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([
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
      ])
    )

    await updateHostEndpoint('host-1', 'ws://192.168.1.10:6768')

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'orca:hosts',
      JSON.stringify([
        {
          id: 'host-1',
          name: 'Desk',
          endpoint: 'ws://192.168.1.10:6768',
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
      ])
    )
  })

  it('throws when the host is missing', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('[]')
    await expect(updateHostEndpoint('missing', 'ws://1.2.3.4:6768')).rejects.toThrow(
      'Host not found'
    )
    expect(AsyncStorage.setItem).not.toHaveBeenCalled()
  })
})
