import type { ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue, AiVaultSession } from '../../../src/shared/ai-vault-types'

const state = vi.hoisted(() => {
  const sessions: AiVaultSession[] = []
  const issues: AiVaultScanIssue[] = []
  return { sessions, issues, refresh: vi.fn(() => Promise.resolve()) }
})

vi.mock('react-native', async () => {
  const { createElement, cloneElement } = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    RefreshControl: 'RefreshControl',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
    StyleSheet: { create: (value: unknown) => value },
    SectionList: ({
      sections,
      ListHeaderComponent,
      ListEmptyComponent,
      renderItem,
      ...props
    }: {
      sections: { data: unknown[] }[]
      ListHeaderComponent?: ReactElement
      ListEmptyComponent?: ReactElement
      renderItem: (args: { item: unknown }) => ReactElement
    }) =>
      createElement(
        'SectionList',
        { ...props, sections },
        ListHeaderComponent,
        sections.length === 0
          ? ListEmptyComponent
          : sections.flatMap((section, group) =>
              section.data.map((item, index) =>
                cloneElement(renderItem({ item }), { key: `${group}:${index}` })
              )
            )
      )
  }
})
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', Play: 'Icon', RefreshCw: 'Icon' }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: vi.fn(), push: vi.fn() })
}))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => ({ client: null, state: 'disconnected' })
}))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
vi.mock('../hooks/use-now', () => ({ useNow: () => Date.parse('2026-10-02T00:00:00Z') }))
vi.mock('./use-mobile-agent-history-state', () => ({
  useMobileAgentHistoryState: () => ({
    scope: 'all',
    screenState: { kind: 'ready', sessions: state.sessions, issues: state.issues },
    refreshing: false,
    hostStatusResult: null,
    activeWorktreePath: null,
    scopeFilterPaths: [],
    onSelectScope: vi.fn(),
    onRefresh: state.refresh,
    retry: null
  })
}))

import { MobileAgentSessionHistoryPanel } from './MobileAgentSessionHistoryPanel'
import { styles } from './agent-history-styles'

let tree: ReactTestRenderer | undefined

beforeEach(() => {
  state.sessions = []
  state.issues = Array.from({ length: 500 }, (_, index) => ({
    agent: 'opencode2',
    kind: 'scope',
    executionHostId: 'ssh:history-host',
    path: `/history/source-${index}/opencode.db`,
    message: `Source ${index} unavailable. Refresh to try again.`
  }))
  state.refresh.mockClear()
})

afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
})

function mount() {
  act(() => {
    tree = create(<MobileAgentSessionHistoryPanel hostId="history-host" worktreeId="folder:test" />)
  })
  if (!tree) {
    throw new Error('History panel did not mount')
  }
  return tree.root
}

function visibleSession(): AiVaultSession {
  return {
    id: 'local:opencode2:session',
    executionHostId: 'local',
    agent: 'opencode2',
    sessionId: 'session',
    title: 'Existing history remains browsable',
    cwd: '/history/project',
    branch: null,
    model: null,
    filePath: '/history/opencode.db',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-01T00:00:00Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}

it('keeps every source notice and session inside the same bounded scroll viewport', () => {
  state.sessions = [visibleSession()]
  const root = mount()
  const list = root.find((node) => String(node.type) === 'SectionList')
  const notice = (node: { props: { children?: unknown } }) =>
    typeof node.props.children === 'string' && node.props.children.startsWith('Source ')

  expect(root.findAll(notice)).toHaveLength(500)
  expect(list.findAll(notice)).toHaveLength(500)
  expect(list.findAll((node) => node.props.children === state.sessions[0]?.title)).toHaveLength(1)
  expect(list.props.style).toEqual(styles.listViewport)
  expect(
    list.findAll((node) => node.props.accessibilityLabel === 'Refresh agent sessions')
  ).toEqual([])
  expect(list.findAll((node) => String(node.type) === 'TextInput')).toEqual([])

  const refresh = root.find((node) => node.props.accessibilityLabel === 'Refresh agent sessions')
  act(() => refresh.props.onPress())
  expect(state.refresh).toHaveBeenCalledOnce()
})

it('keeps the empty state and pull-to-refresh reachable below a long notice list', () => {
  const root = mount()
  const list = root.find((node) => String(node.type) === 'SectionList')

  expect(list.props.contentContainerStyle).toContain(styles.emptyList)
  expect(list.findAll((node) => node.props.children === 'No agent sessions')).toHaveLength(1)
  expect(list.findAll((node) => node.props.children === state.issues.at(-1)?.message)).toHaveLength(
    1
  )
  act(() => list.props.refreshControl.props.onRefresh())
  expect(state.refresh).toHaveBeenCalledOnce()
})
