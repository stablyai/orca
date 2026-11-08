import AsyncStorage from '@react-native-async-storage/async-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadPendingHostCredentialCleanup,
  loadPendingHostCredentialCleanupIds,
  recordHostCredentialCleanupIntent,
  resetHostCredentialCleanupForTests
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

describe('host credential cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
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

  it('records cleanup intent without starting native deletion', async () => {
    await recordHostCredentialCleanupIntent('host-1')

    await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual(['host-1'])
  })

  it('reports storageUnreadable when the durable queue cannot be read', async () => {
    storedPendingIds = ['host-a']

    readShouldFail = true
    await expect(loadPendingHostCredentialCleanup()).resolves.toEqual({
      ids: [],
      storageUnreadable: true
    })
  })

  it('soft-loads empty when pending-cleanup storage is malformed', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('{')

    await expect(loadPendingHostCredentialCleanupIds()).resolves.toEqual([])
    await expect(loadPendingHostCredentialCleanup()).resolves.toEqual({
      ids: [],
      storageUnreadable: true
    })
  })
})
