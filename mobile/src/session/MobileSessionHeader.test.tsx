import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { MobileSessionController } from './use-mobile-session-controller'

const layout = vi.hoisted(() => ({ sideRail: true, width: 927 }))
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  Folder: 'Icon',
  GitBranch: 'Icon',
  MoreHorizontal: 'Icon',
  PanelLeftOpen: 'Icon',
  Columns2: 'Icon',
  Plus: 'Icon',
  SquareChevronRight: 'Icon'
}))
vi.mock('./MobileSessionHeaderIconButton', () => ({
  MobileSessionHeaderIconButton: 'HeaderButton'
}))
vi.mock('./MobileSessionTabStrip', () => ({ MobileSessionTabStrip: 'TabStrip' }))
vi.mock('./MobileSessionHeaderMoreActionsSheet', () => ({
  MobileSessionHeaderMoreActionsSheet: 'MoreActionsSheet'
}))
vi.mock('../components/StatusDot', () => ({ StatusDot: 'StatusDot' }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('../layout/host-sidebar-reveal', () => ({ useHostSidebarReveal: () => null }))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isLandscapePhone: false, width: layout.width })
}))
vi.mock('../layout/use-top-chrome-space', () => ({ useTopChromeSpace: () => ({}) }))
vi.mock('../layout/use-shell-side-rail', () => ({ useShellSideRail: () => layout.sideRail }))

import { MobileSessionHeader } from './MobileSessionHeader'

let tree: ReactTestRenderer | undefined

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
  act(() => {
    tree = create(createElement(MobileSessionHeader, { controller }))
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
  expect(tree!.root.find((node) => String(node.type) === 'Pressable').props.disabled).toBe(true)
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
    setShowHeaderMoreActions: vi.fn(),
    showHeaderMoreButton: false
  }
  renderHeader(false, controller)
  const strip = tree!.root.find((node) => String(node.type) === 'TabStrip')
  expect(strip.props.actionsCollapsed).toBe(true)
  const buttons = tree!.root.findAll((node) => String(node.type) === 'HeaderButton')
  expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
    'Back to worktrees',
    'More session actions'
  ])
  act(() => buttons[1].props.onPress())
  expect(controller.setShowHeaderMoreActions).toHaveBeenCalledWith(true)
  const sheet = tree!.root.find((node) => String(node.type) === 'MoreActionsSheet')
  expect(sheet.props.additionalActions.map((action: { label: string }) => action.label)).toEqual([
    'Terminal layout',
    'New tab',
    'Quick commands',
    'File explorer',
    'Source control'
  ])
  for (const action of sheet.props.additionalActions) {
    act(() => action.onPress())
  }
  expect(controller.setShowTerminalLayout).toHaveBeenCalledWith(true)
  expect(controller.handleOpenNewTab).toHaveBeenCalledOnce()
  expect(controller.handleOpenQuickCommands).toHaveBeenCalledOnce()
  expect(controller.handlePanelTap.mock.calls).toEqual([['files'], ['sourceControl']])
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
