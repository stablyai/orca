import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsFileStore, SettingsFileSync } from './settings-file-sync-types'

const syncState = vi.hoisted(() => ({
  releaseStart: (_outcome: 'ok' | 'fail') => {},
  disposed: false
}))

vi.mock('./settings-file-sync', () => ({
  createSettingsFileSync: (): Partial<SettingsFileSync> => {
    syncState.disposed = false
    return {
      start: () =>
        new Promise<void>((resolve, reject) => {
          syncState.releaseStart = (outcome) =>
            outcome === 'ok' ? resolve() : reject(new Error('late failure'))
        }),
      dispose: async () => {
        syncState.disposed = true
      }
    }
  }
}))

import { startUserSettingsFileSync } from './settings-file-startup'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked sync never touches the store.
const unusedStore = {} as unknown as SettingsFileStore

describe('user settings file startup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the instance without waiting for a slow start and disposes it on a late failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const sync = await startUserSettingsFileSync(unusedStore, '/home/u', { startWaitMs: 10 })

    expect(sync).not.toBeNull()
    expect(warn).toHaveBeenCalledWith(
      '[settings-file] settings file start is slow; continuing in background'
    )
    expect(syncState.disposed).toBe(false)

    syncState.releaseStart('fail')
    await vi.waitFor(() => expect(syncState.disposed).toBe(true))
  })

  it('returns null when start fails within the wait', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = startUserSettingsFileSync(unusedStore, '/home/u', { startWaitMs: 5_000 })
    syncState.releaseStart('fail')

    expect(await pending).toBeNull()
    expect(syncState.disposed).toBe(true)
  })

  it('returns the instance once start finishes within the wait', async () => {
    const pending = startUserSettingsFileSync(unusedStore, '/home/u', { startWaitMs: 5_000 })
    syncState.releaseStart('ok')

    expect(await pending).not.toBeNull()
    expect(syncState.disposed).toBe(false)
  })
})
