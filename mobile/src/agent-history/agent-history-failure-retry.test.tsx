import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HostMobileWebAgentHistoryRoute from '../../host-web-app/h/[hostId]/agent-history/[worktreeId]'
import { MobileAgentSessionHistoryPresentation } from './MobileAgentSessionHistoryPresentation'
import { MobileAgentSessionHistoryList } from './MobileAgentSessionHistoryList'
import type { MobileAgentHistoryCard } from './agent-history-session-card'

const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }))
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }))
vi.mock('../../../src/mobile-web/src/native-shell-channel', () => ({
  useMobileWebNativeShell: () => ({
    client: client,
    connection: 'connected',
    resumeRoute: { kind: 'hosts' }
  })
}))
vi.mock('../mobile-web/use-mobile-web-route-params', () => ({
  useMobileWebRouteParams: () => ({ hostId: 'host', worktreeId: 'workspace' })
}))
vi.mock('./MobileAgentSessionHistoryPresentation', () => ({
  MobileAgentSessionHistoryPresentation: () => null
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  SectionList: 'SectionList',
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ Play: () => null }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('./agent-history-styles', () => ({ styles: {} }))

const client = { agentHistory: { snapshot: mocks.snapshot } }
const session = {
  sessionId: 'session',
  agent: 'claude',
  agentLabel: 'Claude',
  title: 'Old session',
  lastMessage: '',
  messageCount: 1,
  updatedAt: null,
  groupKey: 'today',
  groupLabel: 'Today',
  isCurrentWorkspace: true,
  resumeAvailable: true
}
const snapshot = {
  supported: true,
  sessions: [session],
  skippedTranscriptCount: 0,
  nextOffset: null
}
const card: MobileAgentHistoryCard = {
  id: 'claude:session',
  agent: 'claude',
  agentLabel: 'Claude',
  title: 'Old session',
  lastMessage: '',
  messageCount: 1,
  timeAgo: '',
  isCurrentWorktree: true,
  resumeAvailable: true
}
let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('agent-history failed refresh', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    mocks.snapshot.mockResolvedValue(snapshot)
    await act(async () => {
      renderer = create(createElement(HostMobileWebAgentHistoryRoute))
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
  })

  function presentation() {
    return renderer.root.findByType(MobileAgentSessionHistoryPresentation).props as ComponentProps<
      typeof MobileAgentSessionHistoryPresentation
    >
  }

  it.each(['scope', 'search', 'refresh'] as const)(
    'replaces loaded rows with an error after a failed %s request and supports retry',
    async (trigger) => {
      expect(presentation().state).toMatchObject({ kind: 'ready', sections: [{ data: [card] }] })
      mocks.snapshot.mockRejectedValueOnce(new Error('Host request failed'))
      await act(async () => {
        if (trigger === 'scope') {
          presentation().onSelectScope('all')
        } else if (trigger === 'search') {
          presentation().onChangeQuery('new query')
        } else {
          presentation().onRefresh()
        }
      })
      await act(async () => {
        await vi.runAllTimersAsync()
      })
      expect(mocks.snapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({
          scope: trigger === 'scope' ? 'all' : 'workspace',
          query: trigger === 'search' ? 'new query' : '',
          force: trigger === 'refresh'
        })
      )
      expect(presentation().state).toEqual({
        kind: 'error',
        message: 'Unable to load agent sessions'
      })
      await act(async () => {
        presentation().onRetry()
      })
      expect(presentation().state.kind).toBe('ready')
    }
  )
})

describe('agent-history preview retry', () => {
  it.each([
    { turns: [] },
    { turns: [{ role: 'user', text: 'Recovered preview', timestamp: null }] }
  ])(
    'retries failed previews on reopening and caches successful results: %j',
    async ({ turns }) => {
      const loadPreview = vi
        .fn()
        .mockRejectedValueOnce(new Error('Host request failed'))
        .mockResolvedValue(turns)
      await act(async () => {
        renderer = create(
          createElement(MobileAgentSessionHistoryList, {
            sections: [{ key: 'today', label: 'Today', data: [card] }],
            refreshing: false,
            showCurrentWorktreeBadges: false,
            loadPreview,
            onRefresh: vi.fn()
          })
        )
      })
      function row() {
        return renderer.root.findByType('SectionList' as never).props.renderItem({ item: card })
      }
      await act(async () => {
        row().props.onPress()
      })
      expect(loadPreview).toHaveBeenCalledTimes(1)
      await act(async () => {
        row().props.onPress()
      })
      await act(async () => {
        row().props.onPress()
      })
      expect(loadPreview).toHaveBeenCalledTimes(2)
      expect(row().props.previewTurns).toEqual(turns)
      await act(async () => {
        row().props.onPress()
      })
      await act(async () => {
        row().props.onPress()
      })
      expect(loadPreview).toHaveBeenCalledTimes(2)
    }
  )
})
