import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAiVaultTestSession } from '../../shared/ai-vault-session-test-session'
import {
  indexListedSessionMessages,
  resetListedSessionMessageIndexQueue
} from './listed-session-search'

const { syncMock, userData } = vi.hoisted(() => ({
  syncMock: vi.fn(),
  userData: '/tmp/listed-session-search-index'
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => userData
  }
}))

vi.mock('./session-message-fts-store', () => ({
  getAiVaultSessionMessageFtsStore: async () => ({
    sync: (...args: unknown[]) => syncMock(...args)
  })
}))

vi.mock('./session-search-store', () => ({
  getAiVaultSessionFtsStore: () => ({
    sync: vi.fn()
  })
}))

afterEach(() => {
  resetListedSessionMessageIndexQueue()
  syncMock.mockReset()
})

describe('indexListedSessionMessages', () => {
  it('serializes overlapping list syncs so the latest list wins', async () => {
    const first = createAiVaultTestSession({ id: 'claude:first' })
    const second = createAiVaultTestSession({ id: 'claude:second' })
    let release!: () => void
    let inflight = 0
    let maxInflight = 0
    let held = false
    syncMock.mockImplementation(async () => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      if (!held) {
        held = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      inflight -= 1
    })

    const firstSync = indexListedSessionMessages([first])
    await vi.waitFor(() => {
      expect(release).toEqual(expect.any(Function))
    })
    const secondSync = indexListedSessionMessages([first, second])
    expect(syncMock).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([firstSync, secondSync])

    expect(maxInflight).toBe(1)
    expect(syncMock).toHaveBeenCalledTimes(2)
    expect(syncMock.mock.calls[1]?.[0]).toEqual([first, second])
  })
})
