import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { homeWorktreeCountsKey } from '../worktree/home-host-worktree-fetch'
import { restoreHomeQueries } from './home-query-restore'

const LEGACY_KEY = 'orca:home-snapshot:v1'
const asyncStorage = new Map<string, string>()
const storeRows = new Map<string, string>()

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    removeItem: async (key: string) => {
      asyncStorage.delete(key)
    }
  }
}))
vi.mock('../transport/hosts/host-metadata-store', () => ({
  loadStoredHostProfiles: async () => [{ id: 'host-a' }]
}))
vi.mock('../device-store/device-store', () => ({
  processDeviceStore: () => ({
    read: async (hostId: string, _table: string, keys: readonly string[]) => ({
      status: 'ok',
      values: keys.map((key) => storeRows.get(`${hostId}/${key}`) ?? null)
    }),
    write: async (
      hostId: string,
      _table: string,
      ops: readonly { key: string; value: string | null }[]
    ) => {
      for (const op of ops) {
        if (op.value === null) {
          storeRows.delete(`${hostId}/${op.key}`)
        } else {
          storeRows.set(`${hostId}/${op.key}`, op.value)
        }
      }
      return { written: true }
    }
  })
}))

beforeEach(() => {
  asyncStorage.clear()
  storeRows.clear()
})

describe('restoreHomeQueries', () => {
  it('moves the old Home snapshot into the store, so the launch after it still paints the counts', async () => {
    asyncStorage.set(
      LEGACY_KEY,
      JSON.stringify({
        savedAt: 1_794_000_000_000,
        worktreeInfo: {
          'host-a': {
            hostId: 'host-a',
            totalWorktrees: 7,
            activeCount: 2,
            lastActiveWorktree: null
          }
        }
      })
    )
    await restoreHomeQueries(new QueryClient())
    expect(asyncStorage.has(LEGACY_KEY)).toBe(false)

    const relaunched = new QueryClient()
    await restoreHomeQueries(relaunched)
    expect(relaunched.getQueryData(homeWorktreeCountsKey('host-a'))).toEqual({
      totalWorktrees: 7,
      activeCount: 2,
      agents: []
    })
  })
})
