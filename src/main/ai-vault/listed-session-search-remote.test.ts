import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAiVaultTestSession } from '../../shared/ai-vault-session-test-session'
import {
  AI_VAULT_RG_SEARCH_SCOPES,
  emptyAiVaultSearchSessionsResult
} from '../../shared/ai-vault-session-search-scope'

const { syncMock, ftsSearchMock, rgSearchMock, userData } = vi.hoisted(() => ({
  syncMock: vi.fn(),
  ftsSearchMock: vi.fn(),
  rgSearchMock: vi.fn(),
  userData: '/tmp/listed-session-search-remote'
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => userData
  }
}))

vi.mock('./session-message-fts-store', () => ({
  getAiVaultSessionMessageFtsStore: async () => ({
    sync: (...args: unknown[]) => syncMock(...args),
    search: (...args: unknown[]) => ftsSearchMock(...args)
  })
}))

vi.mock('./session-search-store', () => ({
  getAiVaultSessionFtsStore: () => ({
    sync: vi.fn()
  })
}))

vi.mock('./session-transcript-rg', () => ({
  searchAiVaultSessionsWithRg: (...args: unknown[]) => rgSearchMock(...args)
}))

import {
  clearListedAiVaultSessions,
  rememberListedAiVaultSessions,
  resetListedSessionMessageIndexQueue,
  searchListedAiVaultSessions
} from './listed-session-search'

afterEach(() => {
  resetListedSessionMessageIndexQueue()
  clearListedAiVaultSessions()
  syncMock.mockReset()
  ftsSearchMock.mockReset()
  rgSearchMock.mockReset()
})

describe('searchListedAiVaultSessions remote hosts', () => {
  const local = createAiVaultTestSession({
    id: 'claude:local',
    title: 'Local pairing notes',
    executionHostId: 'local'
  })
  const remote = createAiVaultTestSession({
    id: 'claude:ssh',
    title: 'Remote pairing notes',
    executionHostId: 'ssh:dev-box',
    filePath: '/home/ada/.claude/projects/remote.jsonl',
    previewMessages: [{ role: 'user', text: 'pairing on the build box', timestamp: null }]
  })

  it('does not send SSH sessions to desktop rg when FTS is cold', async () => {
    rememberListedAiVaultSessions([local, remote])
    ftsSearchMock.mockReturnValue({
      hits: [],
      matchedIds: [],
      degraded: false,
      indexedSessionCount: 0,
      indexedSessionIds: []
    })
    rgSearchMock.mockResolvedValue({
      ...emptyAiVaultSearchSessionsResult(),
      matchedIds: [local.id],
      usedRg: true
    })

    const result = await searchListedAiVaultSessions({
      query: 'pairing',
      searchScope: 'full',
      sessionIds: [local.id, remote.id],
      executionHostBySessionId: {
        [local.id]: 'local',
        [remote.id]: 'ssh:dev-box'
      }
    })

    expect(rgSearchMock).toHaveBeenCalledTimes(1)
    expect(rgSearchMock.mock.calls[0]?.[0]).toMatchObject({
      sessionIds: [local.id],
      executionHostBySessionId: {
        [local.id]: 'local',
        [remote.id]: 'ssh:dev-box'
      }
    })
    expect(result.matchedIds.sort()).toEqual([local.id, remote.id])
    expect(result.usedRg).toBe(true)
  })

  it('returns unused rg/fts for remote-only lists so the panel can card-filter', async () => {
    rememberListedAiVaultSessions([remote])

    const result = await searchListedAiVaultSessions({
      query: 'pairing',
      searchScope: 'full',
      sessionIds: [remote.id]
    })

    expect(ftsSearchMock).not.toHaveBeenCalled()
    expect(rgSearchMock).not.toHaveBeenCalled()
    expect(result).toEqual(emptyAiVaultSearchSessionsResult())
  })

  it('does not send SSH ids to FTS or rg when local FTS is warm and the remote path is unindexed', async () => {
    rememberListedAiVaultSessions([local, remote])
    ftsSearchMock.mockReturnValue({
      hits: [],
      matchedIds: [],
      degraded: false,
      indexedSessionCount: 1,
      indexedSessionIds: [local.id]
    })

    const result = await searchListedAiVaultSessions({
      query: 'pairing',
      searchScope: 'full',
      sessionIds: [local.id, remote.id]
    })

    expect(ftsSearchMock).toHaveBeenCalledTimes(1)
    expect(ftsSearchMock.mock.calls[0]?.[0]).toMatchObject({
      sessionIds: [local.id]
    })
    expect(rgSearchMock).not.toHaveBeenCalled()
    expect(result.usedFts).toBe(true)
    expect(result.matchedIds).toEqual([remote.id])
  })

  it('does not send a stale local row to desktop rg when the request host map says SSH', async () => {
    const staleRemote = createAiVaultTestSession({
      id: 'claude:ssh',
      title: 'Remote pairing notes',
      executionHostId: 'local',
      filePath: '/home/ada/.claude/projects/remote.jsonl',
      previewMessages: [{ role: 'user', text: 'pairing on the build box', timestamp: null }]
    })
    rememberListedAiVaultSessions([local, staleRemote])
    ftsSearchMock.mockReturnValue({
      hits: [],
      matchedIds: [local.id],
      degraded: false,
      indexedSessionCount: 1,
      indexedSessionIds: [local.id]
    })

    const result = await searchListedAiVaultSessions({
      query: 'pairing',
      searchScope: 'full',
      sessionIds: [local.id, staleRemote.id],
      executionHostBySessionId: {
        [local.id]: 'local',
        [staleRemote.id]: 'ssh:dev-box'
      }
    })

    expect(ftsSearchMock.mock.calls[0]?.[0]).toMatchObject({
      sessionIds: [local.id]
    })
    expect(rgSearchMock).not.toHaveBeenCalled()
    expect(result.usedFts).toBe(true)
    expect(result.matchedIds.sort()).toEqual([local.id, staleRemote.id])
  })

  it('does not send SSH ids to desktop rg when only the request host map is present', async () => {
    rememberListedAiVaultSessions([local])
    ftsSearchMock.mockReturnValue({
      hits: [],
      matchedIds: [local.id],
      degraded: false,
      indexedSessionCount: 1,
      indexedSessionIds: [local.id]
    })

    const result = await searchListedAiVaultSessions({
      query: 'pairing',
      searchScope: 'full',
      sessionIds: [local.id, remote.id],
      executionHostBySessionId: {
        [local.id]: 'local',
        [remote.id]: 'ssh:dev-box'
      }
    })

    expect(ftsSearchMock.mock.calls[0]?.[0]).toMatchObject({
      sessionIds: [local.id]
    })
    expect(rgSearchMock).not.toHaveBeenCalled()
    expect(result.usedFts).toBe(true)
    expect(result.matchedIds).toEqual([local.id])
  })

  it.each([...AI_VAULT_RG_SEARCH_SCOPES])(
    'does not send SSH ids to desktop rg for %s when FTS is warm and the remote path is unindexed',
    async (searchScope) => {
      rememberListedAiVaultSessions([local, remote])
      ftsSearchMock.mockReturnValue({
        hits: [],
        matchedIds: [],
        degraded: false,
        indexedSessionCount: 1,
        indexedSessionIds: [local.id]
      })

      const result = await searchListedAiVaultSessions({
        query: 'pairing',
        searchScope,
        sessionIds: [local.id, remote.id],
        executionHostBySessionId: {
          [local.id]: 'local',
          [remote.id]: 'ssh:dev-box'
        }
      })

      expect(ftsSearchMock.mock.calls[0]?.[0]).toMatchObject({
        sessionIds: [local.id],
        searchScope
      })
      expect(rgSearchMock).not.toHaveBeenCalled()
      expect(result.usedFts).toBe(true)
      expect(result.matchedIds).toEqual([remote.id])
    }
  )

  it('unions FTS local hits with remote card metadata instead of empty local rg', async () => {
    rememberListedAiVaultSessions([local, remote])
    ftsSearchMock.mockReturnValue({
      hits: [],
      matchedIds: [local.id],
      degraded: false,
      indexedSessionCount: 1,
      indexedSessionIds: [local.id]
    })

    const result = await searchListedAiVaultSessions({
      query: 'pairing',
      searchScope: 'full',
      sessionIds: [local.id, remote.id]
    })

    expect(rgSearchMock).not.toHaveBeenCalled()
    expect(result.usedFts).toBe(true)
    expect(result.matchedIds.sort()).toEqual([local.id, remote.id])
  })
})
