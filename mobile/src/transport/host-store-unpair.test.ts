import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mobileWebPagePreferencesStorageKey } from '../mobile-web/mobile-web-page-preferences-store'
import { removeHost, resetHostStoreForTests } from './host-store'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
}))

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

vi.mock('./host-credential-cleanup', () => ({
  cancelPendingHostCredentialCleanup: vi.fn(),
  recordHostCredentialCleanupIntent: vi.fn(),
  scheduleHostCredentialCleanup: vi.fn(),
  retryPendingHostCredentialCleanups: vi.fn()
}))

const HOST = {
  id: 'host-1',
  name: 'Desk',
  endpoint: 'ws://127.0.0.1:1',
  publicKeyB64: 'pk',
  lastConnected: 1
}

describe('unpairing device-local host state', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset().mockResolvedValue(undefined)
    vi.mocked(AsyncStorage.removeItem).mockReset().mockResolvedValue(undefined)
    resetHostStoreForTests()
  })

  it('drops the removed pairing hosted page preferences', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify([HOST]))

    await removeHost(HOST.id)

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(
      mobileWebPagePreferencesStorageKey(HOST.publicKeyB64)
    )
  })

  it('keeps preferences a remaining host with the same pairing key still owns', async () => {
    const sibling = { ...HOST, id: 'host-2', name: 'Laptop' }
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify([HOST, sibling]))

    await removeHost(sibling.id)

    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith(
      mobileWebPagePreferencesStorageKey(HOST.publicKeyB64)
    )
  })

  it('keeps the removal authoritative when the preference delete fails', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify([HOST]))
    vi.mocked(AsyncStorage.removeItem).mockRejectedValue(new Error('storage unavailable'))

    await expect(removeHost(HOST.id)).resolves.toBeUndefined()
  })
})
