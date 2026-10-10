import { expect, it, vi } from 'vitest'
import React from 'react'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { CreateTerminalTab } from '../../../src/shared/rpc-contract/session-tabs-schemas-params'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
const state = vi.hoisted(
  (): {
    generation: number
    client: RpcClient | null
    connection: ConnectionState
    legacy: boolean
    completedBoundary: boolean
    session: AiVaultSession | null
    onResume?: (session: AiVaultSession) => Promise<void>
  } => ({
    generation: 1,
    client: null,
    connection: 'connected',
    legacy: false,
    completedBoundary: false,
    session: null
  })
)
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  SectionList: 'SectionList',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Platform: { OS: 'web', select: (choices: Record<string, unknown>) => choices.web },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', Play: 'Icon', RefreshCw: 'Icon' }))
const notifications = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), push: vi.fn() }))
vi.mock('../platform/haptics', () => ({
  triggerError: notifications.error,
  triggerSuccess: notifications.success
}))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ push: notifications.push, back: vi.fn(), canGoBack: () => false })
}))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => ({ client: state.client, state: state.connection }),
  useForceReconnect: () => vi.fn()
}))
vi.mock('./use-mobile-agent-history-state', () => ({
  useMobileAgentHistoryState: () => ({
    scope: 'workspace',
    screenState: { kind: 'ready', sessions: [state.session], issues: [] },
    refreshing: false,
    hostStatusResult:
      state.generation === 1
        ? {
            hostPlatform: 'darwin',
            capabilities: state.legacy ? [] : ['aiVault.v1', 'session.tabs.qoderOwnedCreate.v1']
          }
        : state.completedBoundary
          ? { hostPlatform: 'darwin', capabilities: [] }
          : null,
    activeWorktreePath: '/owned/workspace',
    scopeFilterPaths: ['/owned/workspace'],
    onSelectScope: vi.fn(),
    onRefresh: vi.fn(),
    retry: vi.fn()
  })
}))
vi.mock('./MobileAgentSessionHistoryList', () => ({
  MobileAgentSessionHistoryList: (props: {
    onResume: (session: AiVaultSession) => Promise<void>
  }) => {
    state.onResume = props.onResume
    return null
  }
}))
import { MobileAgentSessionHistoryPanel } from './MobileAgentSessionHistoryPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it.each([
  ['stable', 'metadata'],
  ['generation', 'metadata'],
  ['generation without render', 'metadata'],
  ['client', 'metadata'],
  ['host', 'metadata'],
  ['legacy reconnect', 'metadata'],
  ['unmount', 'metadata'],
  ['stable', 'preparation'],
  ['generation', 'preparation'],
  ['disconnect', 'preparation'],
  ['stable', 'terminal creation'],
  ['generation', 'terminal creation'],
  ['stable', 'accepted send'],
  ['generation', 'accepted send'],
  ['generation without render', 'accepted send'],
  ['host', 'accepted send'],
  ['unmount', 'accepted send'],
  ['generation', 'owned create accepted']
])('pending resume keeps its owner: %s during %s', async (scenario, boundary) => {
  const cutover = scenario !== 'stable'
  let hostId = 'owned-host'
  notifications.error.mockClear()
  notifications.success.mockClear()
  notifications.push.mockClear()
  state.legacy = boundary === 'accepted send'
  state.completedBoundary = state.legacy || boundary === 'owned create accepted'
  state.generation = 1
  state.connection = 'connected'
  state.session = {
    id: 'qoder:owned-session',
    executionHostId: 'local',
    agent: 'qoder',
    sessionId: 'owned-session',
    title: 'Owned session',
    cwd: '/owned/workspace',
    branch: null,
    model: null,
    filePath: '/owned/qoder-session.json',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-04T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
  if (boundary === 'preparation' || boundary === 'terminal creation') {
    state.session.agent = 'codex'
    state.session.codexHome = '/Users/ada/Library/Application Support/orca/codex-runtime-home/home'
  }
  const worktrees = [
    {
      worktreeId: 'owned-worktree',
      repoId: 'owned-repo',
      repo: 'Owned',
      path: '/owned/workspace',
      branch: 'main',
      displayName: 'Owned',
      liveTerminalCount: 0,
      hasAttachedPty: false,
      preview: '',
      unread: false,
      isPinned: false,
      linkedPR: null
    }
  ]
  const calls: { method: string; params: unknown; generation: number }[] = []
  let rejectOptional: (error: Error) => void = () => {}
  let resolveOptional: (reply: RpcResponse) => void = () => {}
  const pendingOptional = new Promise<RpcResponse>((resolve, reject) => {
    rejectOptional = reject
    resolveOptional = resolve
  })
  const sendRequest: RpcClient['sendRequest'] = vi.fn<RpcClient['sendRequest']>(
    async (method, params) => {
      calls.push({ method, params, generation: state.generation })
      if (method === 'repo.list') {
        return {
          id: 'owned-reply',
          ok: true,
          result: { repos: [{ id: 'owned-repo', path: '/owned/workspace', connectionId: null }] }
        }
      }
      if (method === 'folderWorkspace.list') {
        return boundary === 'metadata'
          ? pendingOptional
          : { id: 'owned-reply', ok: true, result: { workspaces: [] } }
      }
      if (method === 'aiVault.prepareSessionResume') {
        return boundary === 'preparation'
          ? pendingOptional
          : { id: 'owned-reply', ok: true, result: { useRealCodexHome: true } }
      }
      if (method === 'projectGroup.list') {
        return { id: 'owned-reply', ok: true, result: { groups: [] } }
      }
      if (method === 'worktree.ps') {
        return { id: 'owned-reply', ok: true, result: { worktrees } }
      }
      if (method === 'settings.get') {
        return { id: 'owned-reply', ok: true, result: {} }
      }
      if (method === 'session.tabs.createTerminal') {
        return boundary === 'terminal creation' || boundary === 'owned create accepted'
          ? pendingOptional
          : {
              id: 'owned-reply',
              ok: true,
              result: {
                tab: { type: 'terminal', id: 'owned-tab', terminal: 'owned-pty', title: 'Terminal' }
              }
            }
      }
      if (method === 'terminal.send') {
        if (boundary === 'accepted send') {
          return pendingOptional
        }
        return { id: 'owned-reply', ok: true, result: { send: { accepted: true } } }
      }
      throw new Error(`Unexpected method ${method}`)
    }
  )
  const client = {
    ...createFakeRpcClient(
      scenario === 'legacy reconnect' ? {} : { getGeneration: () => state.generation }
    ),
    sendRequest
  }
  state.client = client
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  let resume: Promise<void> | undefined
  const panel = () =>
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(MobileAgentSessionHistoryPanel, { hostId, worktreeId: 'owned-worktree' })
    )
  await act(async () => {
    rendered.tree = create(panel())
  })
  try {
    await act(async () => {
      if (!rendered.tree) {
        throw new Error('missing panel')
      }
      if (!state.session || !state.onResume) {
        throw new Error('missing resume callback')
      }
      resume = state.onResume(state.session)
    })
    expect(calls.some((call) => call.method === 'repo.list')).toBe(true)
    expect(calls.some((call) => call.method === 'folderWorkspace.list')).toBe(true)
    if (
      boundary === 'terminal creation' ||
      boundary === 'owned create accepted' ||
      boundary === 'accepted send'
    ) {
      expect(calls.some((call) => call.method === 'session.tabs.createTerminal')).toBe(true)
    }
    if (boundary === 'preparation') {
      expect(calls.some((call) => call.method === 'aiVault.prepareSessionResume')).toBe(true)
    }
    if (scenario === 'generation' || scenario === 'generation without render') {
      state.generation = 2
    }
    if (scenario === 'client') {
      state.client = { ...createFakeRpcClient(), sendRequest }
    }
    if (scenario === 'host') {
      hostId = 'replacement-host'
    }
    if (scenario === 'legacy reconnect' || scenario === 'disconnect') {
      state.connection = 'reconnecting'
      await act(async () => {
        rendered.tree?.update(panel())
      })
      if (scenario === 'legacy reconnect') {
        state.connection = 'connected'
      }
    }
    if (scenario === 'unmount') {
      await act(async () => {
        rendered.tree?.unmount()
      })
    } else if (scenario !== 'generation without render' && cutover) {
      await act(async () => {
        rendered.tree?.update(panel())
      })
    }
    await act(async () => {
      if (boundary === 'terminal creation' || boundary === 'owned create accepted') {
        resolveOptional({
          id: 'owned-reply',
          ok: true,
          result: {
            tab: { type: 'terminal', id: 'owned-tab', terminal: 'owned-pty', title: 'Terminal' }
          }
        })
      } else if (boundary === 'accepted send') {
        resolveOptional({ id: 'owned-reply', ok: true, result: { send: { accepted: true } } })
      } else if (boundary === 'preparation' && !cutover) {
        resolveOptional({ id: 'owned-reply', ok: true, result: { useRealCodexHome: true } })
      } else {
        rejectOptional(new Error('client_disconnected'))
      }
      await resume
    })
    const createCall = calls.find((call) => call.method === 'session.tabs.createTerminal')
    if (boundary === 'accepted send' || boundary === 'owned create accepted') {
      expect(createCall).toBeDefined()
      expect(calls.filter((call) => call.method === 'terminal.send')).toHaveLength(
        state.legacy ? 1 : 0
      )
      const completion = {
        errors: notifications.error.mock.calls.length,
        successes: notifications.success.mock.calls.length,
        navigations: notifications.push.mock.calls.length
      }
      if (scenario !== 'unmount') {
        await act(async () => {
          if (!state.session || !state.onResume) {
            throw new Error('missing retry')
          }
          await state.onResume(state.session)
        })
        const creates = calls.filter((call) => call.method === 'session.tabs.createTerminal')
        expect(creates).toHaveLength(2)
        const originalCreate = CreateTerminalTab.parse(createCall?.params)
        const retryCreate = CreateTerminalTab.parse(creates[1].params)
        expect(originalCreate.clientMutationId).toEqual(expect.any(String))
        expect(retryCreate.clientMutationId).toEqual(expect.any(String))
        expect(retryCreate.clientMutationId).not.toBe(originalCreate.clientMutationId)
      }
      expect(completion).toEqual({ errors: 0, successes: 1, navigations: cutover ? 0 : 1 })
    } else if (cutover) {
      if (boundary === 'terminal creation') {
        expect(createCall).toBeDefined()
      } else {
        expect(createCall).toBeUndefined()
      }
      expect(calls.some((call) => call.method === 'terminal.send')).toBe(false)
    } else {
      expect(createCall, JSON.stringify(calls)).toBeDefined()
      if (boundary === 'metadata') {
        expect(createCall?.params).toEqual(
          expect.objectContaining({ command: expect.stringContaining('owned-session') })
        )
      } else {
        expect(createCall?.params).not.toHaveProperty('command')
        expect(calls.some((call) => call.method === 'terminal.send')).toBe(true)
      }
    }
  } finally {
    await act(async () => rendered.tree?.unmount())
  }
})
