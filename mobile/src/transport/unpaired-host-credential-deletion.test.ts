import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  removeItem: vi.fn(),
  setItem: vi.fn()
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

import { cacheEndpointAuthSnapshot, peekEndpointAuthHeaders } from './endpoint-auth-headers'
import { resetHostCredentialWriteRevisionsForTests } from './host-credential-write-revision'
import { resetPairingKeychainForTests } from './pairing-keychain'
import { createUnpairedHostCredentialDeletion } from './unpaired-host-credential-deletion'

const AUTH_KEY = 'orca.mobile-endpoint-auth.host-1'

beforeEach(() => {
  vi.clearAllMocks()
  resetPairingKeychainForTests()
  resetHostCredentialWriteRevisionsForTests()
  cacheEndpointAuthSnapshot('host-1', null)
  platformMock.OS = 'android'
  asyncStorageMock.getItem.mockResolvedValue(null)
})

function runDeletion(hasStoredHost: boolean) {
  const onDeleted = vi.fn()
  const deletion = createUnpairedHostCredentialDeletion({
    waitForHostMutations: async () => {},
    hasStoredHost: async () => hasStoredHost,
    onDeleted
  })
  return { onDeleted, promise: deletion('host-1', 0) }
}

describe('unpaired host credential deletion', () => {
  it('deletes edge-auth headers and clears the snapshot', async () => {
    cacheEndpointAuthSnapshot('host-1', { 'X-A': 'b' })
    const { onDeleted, promise } = runDeletion(false)
    await promise

    expect(secureStoreMock.deleteItemAsync.mock.calls.some(([key]) => key === AUTH_KEY)).toBe(true)
    expect(peekEndpointAuthHeaders('host-1')).toBeNull()
    expect(onDeleted).toHaveBeenCalledWith('host-1')
  })

  it('preserves edge-auth headers when the host is still stored', async () => {
    cacheEndpointAuthSnapshot('host-1', { 'X-A': 'b' })
    const { onDeleted, promise } = runDeletion(true)
    await promise

    expect(secureStoreMock.deleteItemAsync.mock.calls.some(([key]) => key === AUTH_KEY)).toBe(false)
    expect(peekEndpointAuthHeaders('host-1')).toEqual({ 'X-A': 'b' })
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
