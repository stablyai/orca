import { beforeEach, describe, expect, it, vi } from 'vitest'

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
const platformMock = vi.hoisted(() => ({ OS: 'android' }))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorageMock }))

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  ...secureStoreMock
}))
vi.mock('react-native', () => ({ Platform: platformMock }))

import { resetPairingKeychainForTests, writePairingKeychainItem } from './pairing-keychain'

const GENERATION_KEY = 'orca:pairing-keychain-generation'
const TOKEN_KEY = 'orca.host-token.host-1782629088232'

// Preserve Expo’s null-message Android GeneralSecurityException shape from #6600.
const ENCRYPT_REJECTION = new Error(
  `Could not encrypt the value for key '${TOKEN_KEY}' under keychain 'key_v1'. Caused by: unknown`
)

describe('pairing keychain', () => {
  let generationRecord: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetPairingKeychainForTests()
    platformMock.OS = 'android'
    generationRecord = null
    asyncStorageMock.getItem.mockImplementation(async (key: string) =>
      key === GENERATION_KEY ? generationRecord : null
    )
    asyncStorageMock.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key === GENERATION_KEY) {
        generationRecord = raw
      }
    })
    secureStoreMock.setItemAsync.mockResolvedValue(undefined)
    secureStoreMock.deleteItemAsync.mockResolvedValue(undefined)
    secureStoreMock.getItemAsync.mockResolvedValue(null)
  })

  it('surfaces the original error when a rotated write also fails', async () => {
    secureStoreMock.setItemAsync.mockRejectedValue(ENCRYPT_REJECTION)

    await expect(writePairingKeychainItem(TOKEN_KEY, 'token')).rejects.toBe(ENCRYPT_REJECTION)
    expect(generationRecord).toBe('1:pending')
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
  })

  it('does not rotate from a guessed generation when the record is unreadable', async () => {
    const storageError = new Error('storage unavailable')
    asyncStorageMock.getItem.mockRejectedValueOnce(storageError)

    await expect(writePairingKeychainItem(TOKEN_KEY, 'token')).rejects.toBe(storageError)

    expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
  })
})
