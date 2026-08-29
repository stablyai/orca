import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostScreen } from '../../app/h/[hostId]/index'
import type { Worktree } from './workspace-list-sections'

const dependencies = vi.hoisted(() => ({
  loadHosts: vi.fn(),
  worktrees: [] as Worktree[]
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  SectionList: 'SectionList',
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}))

vi.mock('expo-router', () => ({
  useFocusEffect: vi.fn(),
  useLocalSearchParams: () => ({ hostId: 'host-1' }),
  usePathname: () => '/h/host-1',
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() })
}))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  Filter: 'Filter',
  Layers: 'Layers',
  List: 'List',
  Moon: 'Moon',
  PanelLeftClose: 'PanelLeftClose',
  Pin: 'Pin',
  Plus: 'Plus',
  Search: 'Search',
  SlidersHorizontal: 'SlidersHorizontal',
  SquareTerminal: 'SquareTerminal',
  UserCircle: 'UserCircle',
  X: 'X'
}))

vi.mock('../transport/host-store', () => ({
  loadHosts: dependencies.loadHosts,
  updateLastConnected: vi.fn()
}))

vi.mock('../transport/client-context', () => ({
  useCloseHost: () => vi.fn(),
  useForceReconnect: () => vi.fn(),
  useHostClient: () => ({ client: null, state: 'connected' })
}))

vi.mock('../transport/client-context-connection-metrics', () => ({
  useLastConnectedAt: () => null,
  useReconnectAttempt: () => 0
}))

vi.mock('../transport/host-removal-lifecycle', () => ({
  removeHostAndCloseClient: vi.fn()
}))

vi.mock('../transport/use-worktree-resync', () => ({
  useWorktreeResync: () => ({ onRefresh: vi.fn(), refreshing: false })
}))

vi.mock('./host-worktree-refresh', () => ({
  startHostWorktreeRefresh: vi.fn()
}))

vi.mock('../cache/worktree-cache', () => ({
  getCachedWorktrees: () => dependencies.worktrees,
  setCachedWorktrees: vi.fn()
}))

vi.mock('../cache/repo-cache', () => ({
  setCachedRepos: vi.fn()
}))

vi.mock('../storage/preferences', () => ({
  loadPinnedIds: () => Promise.resolve(new Set()),
  savePinnedIds: vi.fn()
}))

vi.mock('../hooks/use-now', () => ({
  useNow: () => 0
}))

vi.mock('../hooks/use-active-worktree-scroll', () => ({
  useActiveWorktreeScroll: () => ({
    onScrollToIndexFailed: vi.fn(),
    sectionListRef: { current: null }
  })
}))

vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ contentMaxWidth: 800, isWideLayout: false })
}))

vi.mock('../components/HostProtocolGate', () => ({
  useHostProtocolGates: () => ({ floatingWorkspaceEnabled: false, hostCapabilities: {} })
}))

vi.mock('../components/ActionSheetModal', () => ({ ActionSheetContent: () => null }))
vi.mock('../components/AuthFailedBanner', () => ({ AuthFailedBanner: () => null }))
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: () => null }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('../components/MobileRepoIcon', () => ({ MobileRepoIcon: () => null }))
vi.mock('../components/MobileSearchField', () => ({
  MobileSearchField: (props: unknown) => createElement('TextInput', props)
}))
vi.mock('../components/NewWorkspaceFab', () => ({
  FAB_SIZE: 56,
  NewWorkspaceFab: () => null
}))
vi.mock('../components/NewWorktreeModalController', () => ({
  NewWorktreeModalController: () => null
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: () => null }))
vi.mock('../components/StatusDot', () => ({ StatusDot: () => null }))
vi.mock('../components/WorkspaceDetailPlaceholder', () => ({
  WorkspaceDetailPlaceholder: () => null
}))
vi.mock('../components/WorktreeListRow', () => ({ WorktreeListRow: () => null }))
vi.mock('../agent-history/worktree-navigation-actions', () => ({
  buildWorktreeNavigationActions: () => []
}))

function worktree(worktreeId: string, displayName: string): Worktree {
  return {
    agents: [],
    branch: displayName,
    displayName,
    hasAttachedPty: false,
    isPinned: false,
    linkedPR: null,
    liveTerminalCount: 0,
    path: `/workspace/${displayName}`,
    preview: '',
    repo: displayName,
    repoId: worktreeId,
    status: 'inactive',
    unread: false,
    workspaceKind: 'git',
    worktreeId
  }
}

function sectionWorktreeIds(renderer: ReactTestRenderer): string[] {
  const sectionList = renderer.root.findByType('SectionList')
  return sectionList.props.sections.flatMap((section: { data: Worktree[] }) =>
    section.data.map((item) => item.worktreeId)
  )
}

function pressSearchToggle(renderer: ReactTestRenderer, label: string): void {
  const toggle = renderer.root
    .findAllByType('Pressable')
    .find((node) => node.props.accessibilityLabel === label)
  if (!toggle) {
    throw new Error(`${label} button not found`)
  }
  act(() => toggle.props.onPress())
}

describe('host workspace search', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    dependencies.worktrees = [worktree('orca', 'orca'), worktree('demo', 'demo-project')]
    dependencies.loadHosts.mockReset().mockResolvedValue([{ id: 'host-1', name: 'Host 1' }])
    await act(async () => {
      renderer = create(createElement(HostScreen, { embedded: true, hostId: 'host-1' }))
      await Promise.resolve()
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('restores the full list when a populated search is closed', () => {
    expect(sectionWorktreeIds(renderer!)).toEqual(['demo', 'orca'])

    pressSearchToggle(renderer!, 'Search workspaces')
    const searchField = renderer!.root.findByType('TextInput')
    act(() => searchField.props.onChangeText('demo'))
    expect(sectionWorktreeIds(renderer!)).toEqual(['demo'])

    pressSearchToggle(renderer!, 'Close search')
    expect(renderer!.root.findAllByType('TextInput')).toHaveLength(0)
    expect(sectionWorktreeIds(renderer!)).toEqual(['demo', 'orca'])
  })
})
