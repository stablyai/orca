import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { MobileSessionController } from './use-mobile-session-controller'
import type { SessionTitleCard } from './use-session-title-card'

const layout = vi.hoisted(() => ({ sideRail: true, width: 927 }))
vi.mock('react-native', () => ({
  Animated: { View: 'View' },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Platform: { OS: 'web' },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  Folder: 'Icon',
  GitBranch: 'Icon',
  MoreHorizontal: 'Icon',
  PanelLeftOpen: 'Icon',
  Columns2: 'Icon',
  Plus: 'Icon',
  SquareChevronRight: 'Icon',
  ListChecks: 'Icon'
}))
vi.mock('../components/nav-bar/NavBarButton', () => ({ NavBarButton: 'HeaderButton' }))
vi.mock('../components/nav-bar/PullDownMenu', () => ({ PullDownMenu: 'PullDownMenu' }))
vi.mock('../agent-history/MobileAgentSessionHistoryIcon', () => ({
  MobileAgentSessionHistoryIcon: () => null
}))
vi.mock('./MobileSessionTabStrip', () => ({ MobileSessionTabStrip: 'TabStrip' }))
vi.mock('../components/StatusDot', () => ({ StatusDot: 'StatusDot' }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('../layout/host-sidebar-reveal', () => ({ useHostSidebarReveal: () => null }))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isLandscapePhone: false, width: layout.width })
}))
vi.mock('../layout/use-top-chrome-space', () => ({ useTopChromeSpace: () => ({}) }))
vi.mock('../layout/use-shell-side-rail', () => ({ useShellSideRail: () => layout.sideRail }))

import { NavBar } from '../components/nav-bar/NavBar'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { MobileSessionHeader } from './MobileSessionHeader'

let tree: ReactTestRenderer | undefined

const nodes = (type: string) => tree!.root.findAll((node) => String(node.type) === type)
const labels = (found: { props: { accessibilityLabel?: string } }[]) =>
  found.map((node) => node.props.accessibilityLabel)
const menuGroups = (): ActionSheetAction[][] => nodes('PullDownMenu')[0].props.groups
const menuLabels = () => menuGroups().map((group) => group.map((action) => action.label))

afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
  layout.sideRail = true
  layout.width = 927
})

function renderHeader(
  showConnectionRetry: boolean,
  overrides: Partial<MobileSessionController> = {}
) {
  const forceReconnectHost = vi.fn(async (_hostId: string) => {})
  const controller = mountFixture<MobileSessionController>({
    hostId: 'host-1',
    connState: 'connected',
    activePanel: null,
    presentedConnState: showConnectionRetry ? 'disconnected' : 'connected',
    forceReconnectHost,
    worktreeName: 'Workspace',
    visibleTabs: [{ id: 'tab-a', type: 'terminal', terminal: 'a' }],
    showConnectionRetry,
    connectionEscalated: showConnectionRetry,
    terminalSummary: showConnectionRetry ? 'Connection lost — tap to retry' : '1 tab',
    ...overrides
  })
  const details = mountFixture<SessionTitleCard>({
    besideTabs: layout.sideRail,
    barRef: { current: null },
    backRef: { current: null },
    openerRef: { current: null },
    titleRef: { current: null },
    boundaryRefs: { current: [] },
    active: false,
    titleRequestedOpen: false,
    closeFirst: () => false,
    onAnchorLayout: () => {},
    toggle: () => {}
  })
  act(() => {
    tree = create(createElement(MobileSessionHeader, { controller, details }))
  })
  return forceReconnectHost
}

it('keeps reconnect reachable beside the Duo tabs when the connection is escalated', async () => {
  const reconnect = renderHeader(true)
  const retry = tree!.root.findAllByProps({ accessibilityLabel: 'Reconnect to desktop' })
  expect(retry).toHaveLength(1)
  expect(retry[0].props.disabled).toBe(false)
  expect(tree!.root.find((node) => String(node.type) === 'StatusDot').props.state).toBe(
    'disconnected'
  )
  await act(async () => retry[0].props.onPress())
  expect(reconnect.mock.calls).toEqual([['host-1']])
})

it('keeps a connected Duo header compact while its tabs stay in the top bar', () => {
  renderHeader(false)
  expect(tree!.root.findAllByProps({ accessibilityLabel: 'Reconnect to desktop' })).toHaveLength(0)
  expect(tree!.root.findAll((node) => String(node.type) === 'StatusDot')).toHaveLength(0)
  expect(tree!.root.findAll((node) => String(node.type) === 'Text')).toHaveLength(0)
  expect(tree!.root.find((node) => String(node.type) === 'TabStrip').props.inTopBar).toBe(true)
})

it('keeps an escalated page connection visible without offering a native retry', () => {
  renderHeader(false, {
    connectionEscalated: true,
    presentedConnState: 'disconnected',
    forceReconnectHost: null,
    terminalSummary: "Can't reach desktop"
  })
  expect(tree!.root.findAllByProps({ accessibilityLabel: 'Reconnect to desktop' })).toHaveLength(0)
  const status = tree!.root.find((node) => String(node.type) === 'StatusDot')
  expect(status.parent?.props.disabled).toBe(true)
  expect(tree!.root.find((node) => String(node.type) === 'StatusDot').props.state).toBe(
    'disconnected'
  )
  expect(tree!.root.findAll((node) => node.props.children === "Can't reach desktop")).toHaveLength(
    1
  )
})

it('gives narrow Duo tabs the header width and keeps every collapsed action reachable', () => {
  layout.width = 382
  const controller = {
    canSplitTerminals: true,
    setShowTerminalLayout: vi.fn(),
    handleOpenNewTab: vi.fn(),
    handleOpenQuickCommands: vi.fn(),
    handlePanelTap: vi.fn(),
    setShowHeaderMoreActions: vi.fn()
  }
  renderHeader(false, controller)
  const strip = tree!.root.find((node) => String(node.type) === 'TabStrip')
  expect(strip.props.actionsCollapsed).toBe(true)
  const buttons = nodes('HeaderButton')
  expect(labels(buttons)).toEqual(['Back to worktrees', 'More session actions'])
  act(() => buttons[1].props.onPress())
  expect(controller.setShowHeaderMoreActions).toHaveBeenCalledWith(true)
  expect(menuLabels()).toEqual([
    ['File explorer', 'Source control', 'Quick commands'],
    ['Terminal layout'],
    ['New tab']
  ])
  for (const action of menuGroups().flat()) {
    act(() => action.onPress())
  }
  expect(controller.setShowTerminalLayout).toHaveBeenCalledWith(true)
  expect(controller.handleOpenNewTab).toHaveBeenCalledOnce()
  expect(controller.handleOpenQuickCommands).toHaveBeenCalledOnce()
  expect(controller.handlePanelTap.mock.calls).toEqual([['files'], ['sourceControl']])
})

it('puts a portrait session in one NavBar with source control and the ⋯ menu', () => {
  layout.sideRail = false
  const controller = {
    activePanel: 'files' as const,
    showChecksAction: true,
    showAgentSessionHistoryAction: true,
    canSplitTerminals: true,
    handlePanelTap: vi.fn(),
    openAgentSessionHistory: vi.fn()
  }
  renderHeader(false, controller)
  const bar = tree!.root.findByType(NavBar)
  expect(bar.findAllByProps({ 'aria-expanded': false })).toHaveLength(1)
  const buttons = nodes('HeaderButton')
  expect(labels(buttons)).toEqual([
    'Back to worktrees',
    'Open source control',
    'More session actions'
  ])
  expect(buttons.map((button) => button.props.active)).toEqual([undefined, false, true])
  expect(tree!.root.find((node) => String(node.type) === 'TabStrip').props.inTopBar).toBe(false)
  expect(menuLabels()).toEqual([
    ['File explorer', 'Checks', 'Agent History', 'Quick commands'],
    ['Terminal layout'],
    []
  ])
  const checks = menuGroups()[0][1]
  act(() => checks.onPress())
  act(() => menuGroups()[0][2].onPress())
  expect(controller.handlePanelTap.mock.calls).toEqual([['pr']])
  expect(controller.openAgentSessionHistory).toHaveBeenCalledOnce()
})

it.each([
  { route: { isFolderWorkspaceRoute: true }, files: true },
  { route: { isFloatingWorkspaceRoute: true }, files: false }
])('keeps workspace restrictions in the portrait bar and menu ($route)', ({ route, files }) => {
  layout.sideRail = false
  renderHeader(false, route)
  expect(labels(nodes('HeaderButton'))).toEqual(['Back to worktrees', 'More session actions'])
  expect(menuLabels()[0]).toEqual(files ? ['File explorer', 'Quick commands'] : ['Quick commands'])
})

it('uses the measured header width when a sidebar leaves a wide window with little tab space', () => {
  renderHeader(false)
  const topBar = tree!.root
    .findAll((node) => String(node.type) === 'View')
    .find((node) => node.props.onLayout && node.parent?.type !== MobileSessionHeader)!
  act(() => topBar.props.onLayout({ nativeEvent: { layout: { width: 540 } } }))
  expect(tree!.root.find((node) => String(node.type) === 'TabStrip').props.actionsCollapsed).toBe(
    true
  )
  act(() => topBar.props.onLayout({ nativeEvent: { layout: { width: 927 } } }))
  expect(tree!.root.find((node) => String(node.type) === 'TabStrip').props.actionsCollapsed).toBe(
    false
  )
})
