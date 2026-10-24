import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

const harness = vi.hoisted(() => ({
  sessions: [] as AiVaultSession[],
  calls: [] as { method: string; params: unknown }[],
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  onRefresh: vi.fn(async () => {}),
  client: null as RpcClient | null
}))

vi.mock('react-native', () => {
  const react = require('react') as typeof import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    RefreshControl: 'RefreshControl',
    SectionList: (props: {
      sections: { key: string; data: { id: string }[] }[]
      renderItem: (info: { item: { id: string } }) => ReactElement
      renderSectionHeader?: (info: {
        section: { key: string; data: { id: string }[] }
      }) => ReactElement | null
      keyExtractor?: (item: { id: string }) => string
    }) =>
      react.createElement(
        'SectionList',
        null,
        props.sections.map((section) =>
          react.createElement(
            react.Fragment,
            { key: section.key },
            props.renderSectionHeader?.({ section }),
            section.data.map((item) =>
              react.createElement(
                react.Fragment,
                { key: props.keyExtractor?.(item) ?? item.id },
                props.renderItem({ item })
              )
            )
          )
        )
      ),
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
    Platform: { OS: 'web', select: (choices: Record<string, unknown>) => choices.web },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
  }
})
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  LocateFixed: 'LocateFixed',
  Play: 'Play',
  RefreshCw: 'Icon',
  Square: 'Square'
}))
vi.mock('../platform/haptics', () => ({ triggerError: () => {}, triggerSuccess: () => {} }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => ({
    push: harness.push,
    back: harness.back,
    replace: harness.replace,
    navigate: () => {},
    dismissTo: () => {},
    canGoBack: () => false
  })
}))
vi.mock('../transport/use-workspace-client', () => ({
  useWorkspaceClient: () => ({ client: harness.client, clientId: 'client-1', state: 'connected' })
}))
vi.mock('./use-mobile-agent-history-state', () => ({
  useMobileAgentHistoryState: () => ({
    scope: 'all' as const,
    screenState: { kind: 'ready' as const, sessions: harness.sessions, issues: [] },
    refreshing: false,
    hostStatusResult: null,
    activeWorktreePath: '/Users/ada/repo/app',
    scopeFilterPaths: [] as string[],
    onSelectScope: () => {},
    onRefresh: harness.onRefresh,
    retry: () => {}
  })
}))

import { MobileAgentSessionHistoryPanel } from './MobileAgentSessionHistoryPanel'
import { consumeLocalSessionTabFollow } from '../session/mobile-session-tab-activation'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const OPEN_TAB = { worktreeId: 'wt-open', tabId: 'tab-open', leafId: 'leaf-open' }

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'claude:1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'session-1',
    title: 'Implement vault filters',
    cwd: '/Users/ada/repo/app',
    branch: 'feature/vault',
    model: 'claude-sonnet-4-5',
    filePath: '/Users/ada/.claude/projects/session-1.jsonl',
    codexHome: null,
    createdAt: '2026-06-28T23:00:00.000Z',
    updatedAt: '2026-06-28T23:55:00.000Z',
    modifiedAt: '2026-06-28T23:55:00.000Z',
    messageCount: 4,
    totalTokens: 1200,
    previewMessages: [{ role: 'assistant', text: 'done', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  }
}

function accepted(result: unknown = {}): RpcResponse {
  return { id: 'rpc-1', ok: true, result }
}

function rejected(message: string): RpcResponse {
  return { id: 'rpc-1', ok: false, error: { code: 'failed', message } }
}

function legacyOpenTabSnapshot(): RpcResponse {
  return accepted({
    worktree: 'wt-1',
    publicationEpoch: '1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'tab-legacy',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-legacy::leaf-legacy',
        parentTabId: 'tab-legacy',
        leafId: 'leaf-legacy',
        title: 'Legacy terminal',
        isActive: true,
        agentStatus: {
          state: 'done',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          paneKey: 'tab-legacy:leaf-legacy',
          stateHistory: [],
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'sess-legacy' }
        }
      }
    ]
  })
}

let tree: ReactTestRenderer | null = null

beforeEach(() => {
  harness.calls = []
  harness.push.mockClear()
  harness.replace.mockClear()
  harness.back.mockClear()
  harness.onRefresh.mockClear()
  harness.sessions = [
    session({ id: 'claude:closed', title: 'Closed session' }),
    session({ id: 'claude:open', title: 'Open session', openTab: OPEN_TAB })
  ]
  harness.client = {
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      harness.calls.push({ method, params })
      return accepted()
    })
  } as unknown as RpcClient
})

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

async function mount(
  props: { worktreeId?: string; origin?: string } = {}
): Promise<ReactTestRenderer> {
  await act(async () => {
    tree = create(
      createElement(MobileAgentSessionHistoryPanel, {
        hostId: 'host-a',
        worktreeId: props.worktreeId ?? 'wt-1',
        ...(props.origin === undefined ? {} : { origin: props.origin })
      })
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  if (!tree) {
    throw new Error('panel did not mount')
  }
  return tree
}

function nodes(rendered: ReactTestRenderer, testID: string) {
  return rendered.root.findAll((node) => node.props.testID === testID)
}

async function press(rendered: ReactTestRenderer, testID: string): Promise<void> {
  const [node] = nodes(rendered, testID)
  if (!node) {
    throw new Error(`missing ${testID}`)
  }
  await act(async () => {
    await node.props.onPress({ stopPropagation() {} })
  })
}

describe('mobile agent history open session actions', () => {
  it('renders Play for a closed session', async () => {
    const rendered = await mount()
    expect(nodes(rendered, 'agent-history-resume-claude:closed')).toHaveLength(1)
    expect(nodes(rendered, 'agent-history-jump-claude:closed')).toHaveLength(0)
    expect(nodes(rendered, 'agent-history-close-claude:closed')).toHaveLength(0)
  })

  it('hides Play and renders jump and close while the session tab is open', async () => {
    const rendered = await mount()
    expect(nodes(rendered, 'agent-history-resume-claude:open')).toHaveLength(0)
    expect(nodes(rendered, 'agent-history-jump-claude:open')).toHaveLength(1)
    expect(nodes(rendered, 'agent-history-close-claude:open')).toHaveLength(1)
    expect(nodes(rendered, 'agent-history-jump-claude:open')[0]?.props.accessibilityLabel).toBe(
      'Jump to open session'
    )
    expect(nodes(rendered, 'agent-history-close-claude:open')[0]?.props.accessibilityLabel).toBe(
      'Close open session'
    )
  })

  it('closes the open tab and switches the card back to Play', async () => {
    const rendered = await mount()
    await press(rendered, 'agent-history-close-claude:open')
    expect(harness.calls).toContainEqual({
      method: 'session.tabs.close',
      params: { worktree: 'id:wt-open', tabId: 'tab-open', reason: 'user' }
    })
    expect(harness.onRefresh).toHaveBeenCalledOnce()
    expect(nodes(rendered, 'agent-history-close-claude:open')).toHaveLength(0)
    expect(nodes(rendered, 'agent-history-jump-claude:open')).toHaveLength(0)
    expect(nodes(rendered, 'agent-history-resume-claude:open')).toHaveLength(1)
  })

  it('activates the open tab without creating a terminal', async () => {
    const rendered = await mount()
    await press(rendered, 'agent-history-jump-claude:open')
    expect(harness.calls).toContainEqual({
      method: 'session.tabs.activate',
      params: {
        worktree: 'id:wt-open',
        tabId: 'tab-open',
        leafId: 'leaf-open',
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      }
    })
    expect(consumeLocalSessionTabFollow('wt-open')).toBe(true)
    expect(harness.calls.map((call) => call.method)).not.toContain('terminal.create')
    expect(harness.calls.map((call) => call.method)).not.toContain('session.tabs.createTerminal')
    expect(harness.replace).toHaveBeenCalledWith('/h/host-a/session/wt-open')
    expect(harness.push).not.toHaveBeenCalled()
    expect(harness.back).not.toHaveBeenCalled()
  })

  it('returns to the open session instead of stacking another session route', async () => {
    const rendered = await mount({ worktreeId: 'wt-open', origin: 'session' })
    await press(rendered, 'agent-history-jump-claude:open')
    expect(harness.calls).toContainEqual({
      method: 'session.tabs.activate',
      params: {
        worktree: 'id:wt-open',
        tabId: 'tab-open',
        leafId: 'leaf-open',
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      }
    })
    expect(consumeLocalSessionTabFollow('wt-open')).toBe(true)
    expect(harness.back).toHaveBeenCalledOnce()
    expect(harness.replace).not.toHaveBeenCalled()
    expect(harness.push).not.toHaveBeenCalled()
  })

  it('drops the local follow when activating the open tab fails', async () => {
    harness.client = {
      sendRequest: vi.fn(async (method: string, params?: unknown) => {
        harness.calls.push({ method, params })
        if (method === 'session.tabs.activate') {
          return rejected('tab missing')
        }
        return accepted()
      })
    } as unknown as RpcClient
    const rendered = await mount()
    await press(rendered, 'agent-history-jump-claude:open')
    expect(consumeLocalSessionTabFollow('wt-open')).toBe(false)
    expect(harness.replace).not.toHaveBeenCalled()
    expect(harness.back).not.toHaveBeenCalled()
  })

  it('drops the local follow when activating the open tab throws', async () => {
    harness.client = {
      sendRequest: vi.fn(async (method: string, params?: unknown) => {
        harness.calls.push({ method, params })
        if (method === 'session.tabs.activate') {
          throw new Error('socket closed')
        }
        return accepted()
      })
    } as unknown as RpcClient
    const rendered = await mount()
    await press(rendered, 'agent-history-jump-claude:open')
    expect(consumeLocalSessionTabFollow('wt-open')).toBe(false)
    expect(harness.replace).not.toHaveBeenCalled()
  })

  it('disables Resume while the legacy open-tab lookup is in flight', async () => {
    let releaseTabs: (response: RpcResponse) => void = () => {}
    harness.sessions = [session({ id: 'claude:legacy', sessionId: 'sess-legacy' })]
    harness.client = {
      sendRequest: vi.fn((method: string, params?: unknown) => {
        harness.calls.push({ method, params })
        if (method === 'session.tabs.list') {
          return new Promise<RpcResponse>((resolve) => {
            releaseTabs = resolve
          })
        }
        return Promise.resolve(accepted())
      })
    } as unknown as RpcClient

    const rendered = await mount({ worktreeId: 'wt-1' })
    expect(nodes(rendered, 'agent-history-resume-claude:legacy')[0]?.props.disabled).toBe(true)
    expect(nodes(rendered, 'agent-history-jump-claude:legacy')).toHaveLength(0)

    await act(async () => {
      releaseTabs(legacyOpenTabSnapshot())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(nodes(rendered, 'agent-history-resume-claude:legacy')).toHaveLength(0)
    expect(nodes(rendered, 'agent-history-jump-claude:legacy')).toHaveLength(1)
    expect(nodes(rendered, 'agent-history-jump-claude:legacy')[0]?.props.disabled).toBe(false)
  })

  it('resolves open tabs from session.tabs.list when the host omits openTab', async () => {
    harness.sessions = [session({ id: 'claude:legacy', sessionId: 'sess-legacy' })]
    harness.client = {
      sendRequest: vi.fn(async (method: string, params?: unknown) => {
        harness.calls.push({ method, params })
        if (method === 'session.tabs.list') {
          return legacyOpenTabSnapshot()
        }
        return accepted()
      })
    } as unknown as RpcClient

    const rendered = await mount({ worktreeId: 'wt-1' })
    expect(nodes(rendered, 'agent-history-resume-claude:legacy')).toHaveLength(0)
    expect(nodes(rendered, 'agent-history-jump-claude:legacy')).toHaveLength(1)
    expect(nodes(rendered, 'agent-history-close-claude:legacy')).toHaveLength(1)
  })
})
