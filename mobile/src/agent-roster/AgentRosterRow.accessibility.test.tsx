import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ bottom: 0 })
}))
vi.mock('expo-router', () => ({
  useFocusEffect: () => {},
  useLocalSearchParams: () => ({ hostId: 'host-1' }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() })
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'ChevronLeft', RefreshCw: 'RefreshCw' }))
vi.mock('../cache/worktree-cache', () => ({ setCachedWorktrees: vi.fn() }))
vi.mock('../hooks/use-now', () => ({ useNow: () => 0 }))
vi.mock('../navigation/route-param-reader', () => ({ firstParam: (value: string) => value }))
vi.mock('../transport/client-context', () => ({ useHostClient: () => ({ client: null, state: 'disconnected' }) }))
vi.mock('../transport/host-store', () => ({ loadHosts: async () => [] }))
vi.mock('../worktree/worktree-catalog-operations', () => ({ worktreeCatalogRead: { requestSingleFlight: vi.fn() } }))
vi.mock('../worktree/worktree-catalog-snapshot-client', () => ({ WORKTREE_PS_FULL_LIMIT: 1000 }))
vi.mock('../components/WorktreeAgentRow', () => ({ WorktreeAgentRow: 'WorktreeAgentRow' }))

import { AgentRosterRow } from './AgentRosterRow'
import { MobileAgentRosterScreen } from './MobileAgentRosterScreen'

const agent: RuntimeWorktreeAgentRow = {
  paneKey: 'pane-1',
  parentPaneKey: null,
  state: 'working',
  agentType: 'claude',
  prompt: '',
  lastAssistantMessage: null,
  taskTitle: null,
  displayName: null,
  toolName: null,
  toolInput: null,
  interrupted: false,
  stateStartedAt: 100,
  updatedAt: 200
}

describe('agent roster accessibility', () => {
  it('names agent rows with their worktree and exposes button semantics', () => {
    let renderer
    act(() => {
      renderer = create(
        createElement(AgentRosterRow, {
          entry: { key: 'pane-1', agent, worktreeId: 'wt-1', worktreeLabel: 'orca', unvisited: false },
          now: 0,
          onPress: vi.fn()
        })
      )
    })
    const button = renderer!.root.findByType('Pressable')
    expect(button.props.accessibilityRole).toBe('button')
    expect(button.props.accessibilityLabel).toBe('Open agent in orca')
  })

  it('names the roster navigation controls', () => {
    let renderer
    act(() => {
      renderer = create(createElement(MobileAgentRosterScreen))
    })
    const buttons = renderer!.root.findAllByType('Pressable')
    expect(buttons.map((button) => [button.props.accessibilityRole, button.props.accessibilityLabel])).toEqual([
      ['button', 'Back'],
      ['button', 'Refresh agents']
    ])
  })
})
