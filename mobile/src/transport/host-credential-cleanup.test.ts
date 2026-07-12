import AsyncStorage from '@react-native-async-storage/async-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadPendingHostCredentialCleanupIds,
  resetHostCredentialCleanupForTests,
  retryPendingHostCredentialCleanups,
  scheduleHostCredentialCleanup,
  subscribePendingHostCredentialCleanup
} from './host-credential-cleanup'

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock
}))

const PENDING_STORAGE_KEY = 'orca:pending-host-credential-cleanups'
let storedPendingIds: string[]
let readShouldFail = false

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('host credential cleanup', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    resetHostCredentialCleanupForTests()
    storedPendingIds = []
    readShouldFail = false
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key !== PENDING_STORAGE_KEY) {
        return null
      }
      if (readShouldFail) {
        throw new Error('async storage unavailable')
      }
      return JSON.stringify(storedPendingIds)
    })
    asyncStorageMock.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key === PENDING_STORAGE_KEY) {
        storedPendingIds = JSON.parse(raw) as string[]
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetHostCredentialCleanupForTests()
  })

  it('clears the durable intent after a successful cleanup', async () => {
    const deleteCredential = vi.fn().mockResolvedValue(undefined)

    await scheduleHostCredentialCleanup('host-1', deleteCredential, 20)
    await vi.waitFor(async () => {
      await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual([])
    })
    expect(deleteCredential).toHaveBeenCalledOnce()
  })

  it('persists cleanup intent before a rejected delete for manual retry', async () => {
    const deleteCredential = vi.fn().mockRejectedValue(new Error('keychain unavailable'))
    const listener = vi.fn()
    const unsubscribe = subscribePendingHostCredentialCleanup(listener)

    await scheduleHostCredentialCleanup('host-1', deleteCredential, 20)
    await vi.waitFor(() => expect(deleteCredential).toHaveBeenCalledOnce())
    await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual(['host-1'])
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('records intent before a stalled delete times out', async () => {
    vi.useFakeTimers()
    const deleteCredential = vi.fn(() => new Promise<void>(() => undefined))

    await scheduleHostCredentialCleanup('host-1', deleteCredential, 3_000)
    await flushMicrotasks()
    await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual(['host-1'])

    await vi.advanceTimersByTimeAsync(3_000)
    await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual(['host-1'])
    expect(deleteCredential).toHaveBeenCalledOnce()
  })

  it('returns after durable intent without waiting for the native delete', async () => {
    vi.useFakeTimers()
    const deleteCredential = vi.fn(() => new Promise<void>(() => undefined))

    await expect(
      scheduleHostCredentialCleanup('host-1', deleteCredential, 3_000)
    ).resolves.toBeUndefined()
    await flushMicrotasks()

    expect(storedPendingIds).toEqual(['host-1'])
    expect(deleteCredential).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(3_000)
  })

  it('clears a timed-out pending entry when the native delete later succeeds', async () => {
    vi.useFakeTimers()
    let resolveDelete: (() => void) | null = null
    const deleteCredential = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        })
    )

    await scheduleHostCredentialCleanup('host-1', deleteCredential, 3_000)
    await flushMicrotasks()
    expect(deleteCredential).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual(['host-1'])
    expect(resolveDelete).not.toBeNull()

    resolveDelete?.()
    await vi.waitFor(async () => {
      await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual([])
    })
  })

  it('joins a concurrently observed delete instead of stacking native calls', async () => {
    let resolveDelete: (() => void) | null = null
    const deleteCredential = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        })
    )

    await scheduleHostCredentialCleanup('host-1', deleteCredential, 1_000)
    await vi.waitFor(() => expect(deleteCredential).toHaveBeenCalledOnce())
    const readsBeforeSecondAttempt = asyncStorageMock.getItem.mock.calls.length
    await scheduleHostCredentialCleanup('host-1', deleteCredential, 1_000)
    await vi.waitFor(() => {
      expect(asyncStorageMock.getItem.mock.calls.length).toBeGreaterThan(readsBeforeSecondAttempt)
    })
    await flushMicrotasks()
    expect(deleteCredential).toHaveBeenCalledOnce()

    resolveDelete?.()
    await vi.waitFor(async () => {
      await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual([])
    })
  })

  it('starts a fresh native attempt when the user retries after a timeout', async () => {
    vi.useFakeTimers()
    const deleteCredential = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
      .mockResolvedValueOnce(undefined)

    await scheduleHostCredentialCleanup('host-1', deleteCredential, 3_000)
    await flushMicrotasks()
    expect(deleteCredential).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(retryPendingHostCredentialCleanups(deleteCredential)).resolves.toEqual({
      clearedCount: 1,
      remainingIds: []
    })
    expect(deleteCredential).toHaveBeenCalledTimes(2)
  })

  it('retries only on an explicit call and clears successful ids', async () => {
    storedPendingIds = ['host-1', 'host-2']
    const deleteCredential = vi
      .fn()
      .mockRejectedValueOnce(new Error('still unavailable'))
      .mockResolvedValue(undefined)

    expect(deleteCredential).not.toHaveBeenCalled()
    await expect(retryPendingHostCredentialCleanups(deleteCredential)).resolves.toEqual({
      clearedCount: 1,
      remainingIds: ['host-1']
    })
    expect(deleteCredential).toHaveBeenCalledTimes(2)
  })

  it('does not wipe existing pending ids when storage read fails during mutation', async () => {
    storedPendingIds = ['host-a']
    const deleteCredential = vi.fn().mockRejectedValue(new Error('keychain unavailable'))

    readShouldFail = true
    await scheduleHostCredentialCleanup('host-b', deleteCredential, 20)
    await vi.waitFor(() => expect(deleteCredential).toHaveBeenCalledOnce())
    readShouldFail = false

    // Native delete still runs; durable queue is left untouched (not clobbered).
    expect(deleteCredential).toHaveBeenCalledOnce()
    await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual(['host-a'])
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
  })

  it('cleans a new credential when the same host id is paired and removed again', async () => {
    const deleteCredential = vi.fn().mockResolvedValue(undefined)

    await scheduleHostCredentialCleanup('host-1', deleteCredential, 20)
    await vi.waitFor(async () => {
      await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual([])
    })
    await scheduleHostCredentialCleanup('host-1', deleteCredential, 20)
    await vi.waitFor(async () => {
      expect(deleteCredential).toHaveBeenCalledTimes(2)
      await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual([])
    })

    expect(deleteCredential).toHaveBeenCalledTimes(2)
    await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual([])
  })

  it('soft-loads empty when pending-cleanup storage is malformed', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce('{')

    await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual([])
  })
})
