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

import {
  markHostCredentialWrite,
  resetHostCredentialWriteRevisionsForTests
} from './host-credential-write-revision'
import { cacheEndpointAuthSnapshot, peekEndpointAuthHeaders } from './endpoint-auth-headers'
import { resetPairingKeychainForTests } from './pairing-keychain'
import {
  deleteEndpointAuthHeaders,
  primeEndpointAuthHeaders,
  readEndpointAuthHeaders,
  writeEndpointAuthHeaders
} from './endpoint-auth-headers-store'

const HEADERS_KEY = 'orca.mobile-endpoint-auth.host-1'

beforeEach(() => {
  vi.clearAllMocks()
  resetPairingKeychainForTests()
  resetHostCredentialWriteRevisionsForTests()
  cacheEndpointAuthSnapshot('host-1', null)
  platformMock.OS = 'android'
  asyncStorageMock.getItem.mockResolvedValue(null)
  secureStoreMock.getItemAsync.mockResolvedValue(null)
})

describe('endpoint auth header storage', () => {
  it('round-trips headers through the keychain', async () => {
    let stored: string | null = null
    secureStoreMock.setItemAsync.mockImplementation(async (_key: string, value: string) => {
      stored = value
    })
    secureStoreMock.getItemAsync.mockImplementation(async () => stored)

    await writeEndpointAuthHeaders('host-1', { 'CF-Access-Client-Id': 'id-123' })
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(
      HEADERS_KEY,
      expect.stringContaining('"CF-Access-Client-Id":"id-123"'),
      expect.objectContaining({ keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' })
    )
    expect(await readEndpointAuthHeaders('host-1')).toEqual({ 'CF-Access-Client-Id': 'id-123' })
  })

  it('writes through to the in-memory snapshot', async () => {
    secureStoreMock.setItemAsync.mockResolvedValue(undefined)
    await writeEndpointAuthHeaders('host-1', { 'CF-Access-Client-Id': 'id-123' })
    expect(peekEndpointAuthHeaders('host-1')).toEqual({ 'CF-Access-Client-Id': 'id-123' })
  })

  it('returns null for another host id or corrupt payloads', async () => {
    secureStoreMock.getItemAsync.mockResolvedValue(
      JSON.stringify({ v: 1, hostId: 'host-2', headers: { 'X-A': 'b' } })
    )
    expect(await readEndpointAuthHeaders('host-1')).toBeNull()
    secureStoreMock.getItemAsync.mockResolvedValue('not-json')
    expect(await readEndpointAuthHeaders('host-1')).toBeNull()
  })

  it('deletes headers and clears the cache', async () => {
    secureStoreMock.getItemAsync.mockResolvedValue(
      JSON.stringify({ v: 1, hostId: 'host-1', headers: { 'X-A': 'b' } })
    )
    expect(await primeEndpointAuthHeaders('host-1')).toEqual({ 'X-A': 'b' })
    expect(peekEndpointAuthHeaders('host-1')).toEqual({ 'X-A': 'b' })
    await deleteEndpointAuthHeaders('host-1')
    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalled()
    expect(peekEndpointAuthHeaders('host-1')).toBeNull()
  })

  it('rejects un-normalizable headers instead of persisting them', async () => {
    const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`X-H-${i}`, 'v']))
    await expect(writeEndpointAuthHeaders('host-1', tooMany)).rejects.toThrow(
      'Invalid edge-auth headers'
    )
    await expect(writeEndpointAuthHeaders('host-1', { 'bad name': 'v' })).rejects.toThrow(
      'Invalid edge-auth headers'
    )
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
    expect(peekEndpointAuthHeaders('host-1')).toBeNull()
  })

  it('primes fail-closed when the store throws', async () => {
    secureStoreMock.getItemAsync.mockRejectedValue(new Error('keystore locked'))
    expect(await primeEndpointAuthHeaders('host-1')).toBeNull()
    expect(peekEndpointAuthHeaders('host-1')).toBeNull()
  })

  it('skips caching when the open is no longer current', async () => {
    secureStoreMock.getItemAsync.mockResolvedValue(
      JSON.stringify({ v: 1, hostId: 'host-1', headers: { 'X-A': 'b' } })
    )
    expect(await primeEndpointAuthHeaders('host-1', () => false)).toEqual({ 'X-A': 'b' })
    expect(peekEndpointAuthHeaders('host-1')).toBeNull()
  })

  it('skips caching when headers changed mid-read', async () => {
    secureStoreMock.getItemAsync.mockImplementation(async () => {
      markHostCredentialWrite('host-1')
      return JSON.stringify({ v: 1, hostId: 'host-1', headers: { 'X-Old': 'b' } })
    })
    expect(await primeEndpointAuthHeaders('host-1')).toEqual({ 'X-Old': 'b' })
    expect(peekEndpointAuthHeaders('host-1')).toBeNull()
  })

  it('skips caching when headers were cleared mid-read', async () => {
    secureStoreMock.getItemAsync.mockImplementation(async () => {
      await deleteEndpointAuthHeaders('host-1')
      return JSON.stringify({ v: 1, hostId: 'host-1', headers: { 'X-Old': 'b' } })
    })
    expect(await primeEndpointAuthHeaders('host-1')).toEqual({ 'X-Old': 'b' })
    expect(peekEndpointAuthHeaders('host-1')).toBeNull()
  })
})
