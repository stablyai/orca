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

const ENDPOINT = 'wss://orca.example.com'
const HEADERS_KEY = 'orca.mobile-endpoint-auth.host-1'

beforeEach(() => {
  vi.clearAllMocks()
  resetPairingKeychainForTests()
  resetHostCredentialWriteRevisionsForTests()
  cacheEndpointAuthSnapshot('host-1', null, ENDPOINT)
  platformMock.OS = 'android'
  asyncStorageMock.getItem.mockResolvedValue(null)
  secureStoreMock.getItemAsync.mockResolvedValue(null)
})

describe('endpoint auth header storage', () => {
  it('refuses a canceled queued write without replacing existing credentials', async () => {
    let current = true
    let release: () => void = () => {}
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    secureStoreMock.setItemAsync.mockImplementationOnce(async () => paused)
    const blocker = writeEndpointAuthHeaders('other-host', { 'X-Token': 'other' }, ENDPOINT)
    await vi.waitFor(() => expect(secureStoreMock.setItemAsync).toHaveBeenCalled())
    const mutation = writeEndpointAuthHeaders(
      'host-1',
      { 'X-Token': 'new' },
      ENDPOINT,
      () => current
    )
    const rejected = expect(mutation).rejects.toThrow('cancelled')
    current = false
    release()
    await blocker
    await rejected
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(1)
    expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
  })

  it('restores previous credentials inside the queue when canceled during a native write', async () => {
    let stored = JSON.stringify({
      v: 2,
      hostId: 'host-1',
      origin: ENDPOINT,
      headers: { 'X-Token': 'old' }
    })
    secureStoreMock.getItemAsync.mockImplementation(async () => stored)
    let current = true
    let release: () => void = () => {}
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    secureStoreMock.setItemAsync.mockImplementationOnce(async (_key: string, value: string) => {
      stored = value
      await paused
    })
    secureStoreMock.setItemAsync.mockImplementation(async (_key: string, value: string) => {
      stored = value
    })
    const mutation = writeEndpointAuthHeaders(
      'host-1',
      { 'X-Token': 'new' },
      ENDPOINT,
      () => current
    )
    const rejected = expect(mutation).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(secureStoreMock.setItemAsync).toHaveBeenCalled())
    current = false
    release()
    await rejected
    expect(await readEndpointAuthHeaders('host-1', ENDPOINT)).toEqual({ 'X-Token': 'old' })
    expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
  })

  it.each(['remove', 'replace'] as const)(
    'lets a newer %s win over an in-flight guarded save',
    async (action) => {
      let stored: string | null = null
      secureStoreMock.getItemAsync.mockImplementation(async () => stored)
      secureStoreMock.deleteItemAsync.mockImplementation(async () => {
        stored = null
      })
      let release: () => void = () => {}
      const paused = new Promise<void>((resolve) => {
        release = resolve
      })
      secureStoreMock.setItemAsync.mockImplementationOnce(async (_key: string, value: string) => {
        stored = value
        await paused
      })
      secureStoreMock.setItemAsync.mockImplementation(async (_key: string, value: string) => {
        stored = value
      })
      const older = writeEndpointAuthHeaders('host-1', { 'X-Token': 'stale' }, ENDPOINT, () => true)
      const rejected = expect(older).rejects.toThrow('cancelled')
      await vi.waitFor(() => expect(secureStoreMock.setItemAsync).toHaveBeenCalled())
      const newer =
        action === 'remove'
          ? deleteEndpointAuthHeaders('host-1')
          : writeEndpointAuthHeaders('host-1', { 'X-Token': 'newer' }, ENDPOINT)
      release()
      await rejected
      await newer
      const expected = action === 'remove' ? null : { 'X-Token': 'newer' }
      expect(await readEndpointAuthHeaders('host-1', ENDPOINT)).toEqual(expected)
      expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toEqual(expected)
    }
  )

  it('does not use legacy credentials without an origin binding', async () => {
    secureStoreMock.getItemAsync.mockResolvedValue(
      JSON.stringify({ v: 1, hostId: 'host-1', headers: { 'X-Token': 'old-secret' } })
    )
    expect(await readEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
  })

  it('rejects credential writes for an insecure endpoint', async () => {
    await expect(
      writeEndpointAuthHeaders('host-1', { 'X-Token': 'secret' }, 'ws://orca.example.com')
    ).rejects.toThrow()
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
  })

  it('never exposes an old origin credential to a new endpoint after a failed save', async () => {
    let stored: string | null = null
    secureStoreMock.setItemAsync.mockImplementation(async (_key: string, value: string) => {
      stored = value
    })
    secureStoreMock.getItemAsync.mockImplementation(async () => stored)
    await writeEndpointAuthHeaders('host-1', { 'X-Token': 'secret-A' }, 'wss://a.example.com')
    secureStoreMock.setItemAsync.mockRejectedValueOnce(new Error('keychain unavailable'))
    await expect(
      writeEndpointAuthHeaders('host-1', { 'X-Token': 'secret-B' }, 'wss://b.example.com')
    ).rejects.toThrow()

    expect(await readEndpointAuthHeaders('host-1', 'wss://b.example.com')).toBeNull()
    expect(peekEndpointAuthHeaders('host-1', 'wss://b.example.com')).toBeNull()
    expect(await readEndpointAuthHeaders('host-1', 'wss://a.example.com')).toEqual({
      'X-Token': 'secret-A'
    })
  })

  it('does not clear a newer snapshot when a canceled credential read rejects', async () => {
    let rejectOld: (error: Error) => void = () => {}
    let current = true
    secureStoreMock.getItemAsync.mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectOld = reject
        })
    )
    const older = primeEndpointAuthHeaders('host-1', ENDPOINT, () => current)
    await vi.waitFor(() => expect(secureStoreMock.getItemAsync).toHaveBeenCalled())
    secureStoreMock.getItemAsync.mockResolvedValue(
      JSON.stringify({ v: 2, origin: ENDPOINT, hostId: 'host-1', headers: { 'X-Token': 'newer' } })
    )
    await primeEndpointAuthHeaders('host-1', ENDPOINT)
    current = false
    rejectOld(new Error('old read failed'))
    await older

    expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toEqual({ 'X-Token': 'newer' })
  })

  it('round-trips headers through the keychain', async () => {
    let stored: string | null = null
    secureStoreMock.setItemAsync.mockImplementation(async (_key: string, value: string) => {
      stored = value
    })
    secureStoreMock.getItemAsync.mockImplementation(async () => stored)

    await writeEndpointAuthHeaders('host-1', { 'CF-Access-Client-Id': 'id-123' }, ENDPOINT)
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(
      HEADERS_KEY,
      expect.stringContaining('"CF-Access-Client-Id":"id-123"'),
      expect.objectContaining({ keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' })
    )
    expect(await readEndpointAuthHeaders('host-1', ENDPOINT)).toEqual({
      'CF-Access-Client-Id': 'id-123'
    })
  })

  it('writes through to the in-memory snapshot', async () => {
    secureStoreMock.setItemAsync.mockResolvedValue(undefined)
    await writeEndpointAuthHeaders('host-1', { 'CF-Access-Client-Id': 'id-123' }, ENDPOINT)
    expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toEqual({ 'CF-Access-Client-Id': 'id-123' })
  })

  it('returns null for another host id or corrupt payloads', async () => {
    secureStoreMock.getItemAsync.mockResolvedValue(
      JSON.stringify({ v: 2, origin: ENDPOINT, hostId: 'host-2', headers: { 'X-A': 'b' } })
    )
    expect(await readEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
    secureStoreMock.getItemAsync.mockResolvedValue('not-json')
    expect(await readEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
  })

  it('deletes headers and clears the cache', async () => {
    secureStoreMock.getItemAsync.mockResolvedValue(
      JSON.stringify({ v: 2, origin: ENDPOINT, hostId: 'host-1', headers: { 'X-A': 'b' } })
    )
    expect(await primeEndpointAuthHeaders('host-1', ENDPOINT)).toEqual({ 'X-A': 'b' })
    expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toEqual({ 'X-A': 'b' })
    await deleteEndpointAuthHeaders('host-1')
    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalled()
    expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
  })

  it('rejects un-normalizable headers instead of persisting them', async () => {
    const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`X-H-${i}`, 'v']))
    await expect(writeEndpointAuthHeaders('host-1', tooMany, ENDPOINT)).rejects.toThrow(
      'Invalid edge-auth headers'
    )
    await expect(writeEndpointAuthHeaders('host-1', { 'bad name': 'v' }, ENDPOINT)).rejects.toThrow(
      'Invalid edge-auth headers'
    )
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
    expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
  })

  it('primes fail-closed when the store throws', async () => {
    secureStoreMock.getItemAsync.mockRejectedValue(new Error('keystore locked'))
    expect(await primeEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
    expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
  })

  it('skips caching when the open is no longer current', async () => {
    secureStoreMock.getItemAsync.mockResolvedValue(
      JSON.stringify({ v: 2, origin: ENDPOINT, hostId: 'host-1', headers: { 'X-A': 'b' } })
    )
    expect(await primeEndpointAuthHeaders('host-1', ENDPOINT, () => false)).toEqual({ 'X-A': 'b' })
    expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
  })

  it('skips caching when headers changed mid-read', async () => {
    secureStoreMock.getItemAsync.mockImplementation(async () => {
      markHostCredentialWrite('host-1')
      return JSON.stringify({ v: 2, origin: ENDPOINT, hostId: 'host-1', headers: { 'X-Old': 'b' } })
    })
    expect(await primeEndpointAuthHeaders('host-1', ENDPOINT)).toEqual({ 'X-Old': 'b' })
    expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
  })

  it('skips caching when headers were cleared mid-read', async () => {
    secureStoreMock.getItemAsync.mockImplementation(async () => {
      await deleteEndpointAuthHeaders('host-1')
      return JSON.stringify({ v: 2, origin: ENDPOINT, hostId: 'host-1', headers: { 'X-Old': 'b' } })
    })
    expect(await primeEndpointAuthHeaders('host-1', ENDPOINT)).toEqual({ 'X-Old': 'b' })
    expect(peekEndpointAuthHeaders('host-1', ENDPOINT)).toBeNull()
  })
})
