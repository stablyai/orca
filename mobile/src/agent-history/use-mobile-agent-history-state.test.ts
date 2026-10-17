import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  clearMobileAiVaultMemoryCache,
  getMobileAiVaultCacheKey,
  MOBILE_AI_VAULT_INITIAL_LIMIT,
  MOBILE_AI_VAULT_SESSION_LIMIT,
  writeMobileAiVaultCache
} from './mobile-ai-vault-session-cache'

const connection = vi.hoisted((): { client: RpcClient | null; state: ConnectionState } => ({
  client: null,
  state: 'connected'
}))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => connection,
  useForceReconnect: () => vi.fn()
}))

import {
  useMobileAgentHistoryState,
  type MobileAgentHistoryState
} from './use-mobile-agent-history-state'

const fingerprint = 'c'.repeat(64)

function session(id: string, cwd = '/owned/workspace'): AiVaultSession {
  return {
    id,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: id,
    title: id,
    cwd,
    branch: 'main',
    model: null,
    filePath: `${cwd}/${id}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-06-28T23:55:00.000Z',
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}

function worktree(path = '/owned/workspace'): Worktree {
  return {
    worktreeId: 'owned-worktree',
    path,
    repoId: 'repo-1',
    repo: 'repo',
    branch: 'main',
    displayName: 'owned-worktree'
  }
}

function fakeClient(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => connection.state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {},
    getGeneration: () => 1
  }
}

function statusReply(capabilities: string[] = ['aiVault.v1']): RpcResponse {
  return { id: 'status', ok: true, result: { hostPlatform: 'darwin', capabilities } }
}

function scanReply(result: Record<string, unknown>): RpcResponse {
  return { id: 'scan', ok: true, result }
}

describe('useMobileAgentHistoryState staged load and SWR', () => {
  beforeEach(() => {
    clearMobileAiVaultMemoryCache()
    connection.client = null
    connection.state = 'connected'
  })

  afterEach(() => {
    clearMobileAiVaultMemoryCache()
  })

  it('stages limit 30 then 250 on a cold open', async () => {
    const limits: number[] = []
    const send = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
      if (method === 'status.get') {
        return statusReply()
      }
      const limit = typeof params === 'object' && params && 'limit' in params ? params.limit : null
      if (typeof limit === 'number') {
        limits.push(limit)
      }
      if (limit === MOBILE_AI_VAULT_INITIAL_LIMIT) {
        return scanReply({
          sessions: Array.from({ length: MOBILE_AI_VAULT_INITIAL_LIMIT }, (_, index) =>
            session(`s${index}`)
          ),
          issues: [],
          fingerprint: 'd'.repeat(64)
        })
      }
      return scanReply({
        sessions: [session('full')],
        issues: [],
        fingerprint
      })
    })
    connection.client = fakeClient(send)
    const observed: { current: MobileAgentHistoryState | null } = { current: null }
    let tree: ReactTestRenderer | null = null
    const worktrees = [worktree()]
    function Probe() {
      observed.current = useMobileAgentHistoryState({
        hostId: 'host-1',
        worktreeId: 'owned-worktree',
        worktrees,
        worktreesLoaded: true
      })
      return null
    }
    await act(async () => {
      tree = create(createElement(Probe))
    })
    try {
      expect(limits).toEqual([MOBILE_AI_VAULT_INITIAL_LIMIT, MOBILE_AI_VAULT_SESSION_LIMIT])
      expect(observed.current?.screenState).toMatchObject({
        kind: 'ready',
        sessions: [expect.objectContaining({ id: 'full' })]
      })
      const firstScan = send.mock.calls.find((call) => call[0] === 'aiVault.listSessions')
      expect(firstScan?.[1]).toMatchObject({ afterFingerprint: null })
    } finally {
      act(() => {
        tree?.unmount()
      })
    }
  })

  it('revalidates a full cache with afterFingerprint and keeps rows on unchanged', async () => {
    const key = getMobileAiVaultCacheKey('host-1', 'owned-worktree', 'workspace')
    writeMobileAiVaultCache(key, {
      sessions: [session('cached')],
      issues: [],
      fingerprint,
      limit: MOBILE_AI_VAULT_SESSION_LIMIT
    })
    const send = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
      if (method === 'status.get') {
        return statusReply()
      }
      expect(params).toMatchObject({
        limit: MOBILE_AI_VAULT_SESSION_LIMIT,
        afterFingerprint: fingerprint,
        force: false
      })
      return scanReply({ sessions: [], issues: [], fingerprint, unchanged: true })
    })
    connection.client = fakeClient(send)
    const observed: { current: MobileAgentHistoryState | null } = { current: null }
    let tree: ReactTestRenderer | null = null
    const worktrees = [worktree()]
    function Probe() {
      observed.current = useMobileAgentHistoryState({
        hostId: 'host-1',
        worktreeId: 'owned-worktree',
        worktrees,
        worktreesLoaded: true
      })
      return null
    }
    await act(async () => {
      tree = create(createElement(Probe))
    })
    try {
      expect(observed.current?.screenState).toEqual({
        kind: 'ready',
        sessions: [expect.objectContaining({ id: 'cached' })],
        issues: []
      })
      expect(observed.current?.screenState.kind === 'ready' && observed.current.screenState.sessions[0]?.id).toBe(
        'cached'
      )
      expect(send.mock.calls.filter((call) => call[0] === 'aiVault.listSessions')).toHaveLength(1)
    } finally {
      act(() => {
        tree?.unmount()
      })
    }
  })

  it('does not paint a scoped cache before scopeFilterPaths exist', async () => {
    const key = getMobileAiVaultCacheKey('host-1', 'owned-worktree', 'workspace')
    writeMobileAiVaultCache(key, {
      sessions: [session('other', '/other/project')],
      issues: [],
      fingerprint,
      limit: MOBILE_AI_VAULT_SESSION_LIMIT
    })
    const send = vi.fn<RpcClient['sendRequest']>(async (method) => {
      if (method === 'status.get') {
        return statusReply()
      }
      return scanReply({ sessions: [], issues: [] })
    })
    connection.client = fakeClient(send)
    const observed: { current: MobileAgentHistoryState | null } = { current: null }
    let tree: ReactTestRenderer | null = null
    const emptyWorktrees: Worktree[] = []
    function Probe() {
      observed.current = useMobileAgentHistoryState({
        hostId: 'host-1',
        worktreeId: 'owned-worktree',
        worktrees: emptyWorktrees,
        worktreesLoaded: false
      })
      return null
    }
    await act(async () => {
      tree = create(createElement(Probe))
    })
    try {
      expect(observed.current?.screenState.kind).toBe('loading')
      expect(send.mock.calls.some((call) => call[0] === 'aiVault.listSessions')).toBe(false)
    } finally {
      act(() => {
        tree?.unmount()
      })
    }
  })

  it('force refresh requests depth 250 without a prior fingerprint', async () => {
    const key = getMobileAiVaultCacheKey('host-1', 'owned-worktree', 'workspace')
    writeMobileAiVaultCache(key, {
      sessions: [session('cached')],
      issues: [],
      fingerprint,
      limit: MOBILE_AI_VAULT_SESSION_LIMIT
    })
    const send = vi.fn<RpcClient['sendRequest']>(async (method) => {
      if (method === 'status.get') {
        return statusReply()
      }
      return scanReply({
        sessions: [session('forced')],
        issues: [],
        fingerprint: 'e'.repeat(64)
      })
    })
    connection.client = fakeClient(send)
    const observed: { current: MobileAgentHistoryState | null } = { current: null }
    let tree: ReactTestRenderer | null = null
    const worktrees = [worktree()]
    function Probe() {
      observed.current = useMobileAgentHistoryState({
        hostId: 'host-1',
        worktreeId: 'owned-worktree',
        worktrees,
        worktreesLoaded: true
      })
      return null
    }
    await act(async () => {
      tree = create(createElement(Probe))
    })
    try {
      send.mockClear()
      await act(async () => {
        await observed.current?.onRefresh()
      })
      const refreshScan = send.mock.calls.find((call) => call[0] === 'aiVault.listSessions')
      expect(refreshScan?.[1]).toMatchObject({
        limit: MOBILE_AI_VAULT_SESSION_LIMIT,
        force: true,
        afterFingerprint: null
      })
      expect(observed.current?.screenState).toMatchObject({
        kind: 'ready',
        sessions: [expect.objectContaining({ id: 'forced' })]
      })
    } finally {
      act(() => {
        tree?.unmount()
      })
    }
  })
})
