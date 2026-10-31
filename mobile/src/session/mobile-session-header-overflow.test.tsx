import { createElement, useRef, useState, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { MobileSessionController } from './use-mobile-session-controller'
import type { SessionTitleCard } from './use-session-title-card'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Modal: 'Modal',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'web' },
  StyleSheet: { create: <T,>(v: T) => v, hairlineWidth: 1, absoluteFill: {} },
  useWindowDimensions: () => ({ width: 382, height: 800 }),
  Animated: {
    View: 'AnimatedView',
    Value: class {
      setValue() {}
      interpolate() {
        return this
      }
    },
    timing: () => ({ start: () => {} })
  }
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
  File: 'Icon',
  FileText: 'Icon',
  Globe: 'Icon',
  SquareTerminal: 'Icon',
  Check: 'Icon',
  Rows2: 'Icon',
  LayoutGrid: 'Icon',
  Edit3: 'Icon',
  Trash2: 'Icon',
  ListChecks: 'Icon'
}))
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ children, ...props }: { children: ReactNode; visible: boolean }) =>
    createElement('Drawer', props, props.visible ? children : null)
}))
vi.mock('../agent-history/MobileAgentSessionHistoryIcon', () => ({
  MobileAgentSessionHistoryIcon: () => null
}))
vi.mock('../components/StatusDot', () => ({ StatusDot: () => null }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../components/AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: () => {} }))
vi.mock('../hooks/use-now', () => ({ useNow: () => 0 }))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('../layout/host-sidebar-reveal', () => ({ useHostSidebarReveal: () => null }))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ width: 382, isLandscapePhone: false })
}))
vi.mock('../layout/use-top-chrome-space', () => ({ useTopChromeSpace: () => ({}) }))
vi.mock('../layout/use-shell-side-rail', () => ({ useShellSideRail: () => true }))
vi.mock('../platform/keyboard-persisting-taps', () => ({
  useKeyboardPersistingTaps: () => () => {}
}))
vi.mock('../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}))

import { MobileSessionHeader } from './MobileSessionHeader'
import { MobileSessionTerminalLayoutSheet } from './MobileSessionTerminalLayoutSheet'

let tree: ReactTestRenderer | undefined
let frames: FrameRequestCallback[] = []
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
  frames = []
  vi.unstubAllGlobals()
})

function mountHeader(overrides: Partial<MobileSessionController> = {}) {
  const callbacks = {
    handleOpenNewTab: vi.fn(),
    handleOpenQuickCommands: vi.fn(),
    handlePanelTap: vi.fn(),
    openAgentSessionHistory: vi.fn(),
    setTerminalSplitLayout: vi.fn(),
    toggleTerminalSplit: vi.fn()
  }
  function Screen() {
    const [showHeaderMoreActions, setShowHeaderMoreActions] = useState(false)
    const [showTerminalLayout, setShowTerminalLayout] = useState(false)
    const [activeSessionTabId, setActiveSessionTabId] = useState('a')
    const controller = mountFixture<MobileSessionController>({
      ...callbacks,
      ...overrides,
      showHeaderMoreActions,
      setShowHeaderMoreActions,
      showTerminalLayout,
      setShowTerminalLayout,
      activeSessionTabId,
      activeSessionTabIdRef: useRef('a'),
      activeHandleRef: useRef('term-a'),
      tabStripRef: useRef(null),
      tabStripOffsetRef: useRef(0),
      tabStripViewportWidthRef: useRef(0),
      tabStripContentWidthRef: useRef(0),
      tabLayoutsRef: useRef(new Map()),
      visibleTabs: [
        { id: 'a', type: 'terminal', terminal: 'term-a', title: 'First' },
        { id: 'b', type: 'terminal', terminal: 'term-b', title: 'Second' }
      ],
      terminals: [],
      switchSessionTab: (tab) => setActiveSessionTabId(tab.id),
      cancelHeldTabStripReveal: () => {},
      scrollActiveTabIntoView: () => {},
      canSplitTerminals: true,
      connState: overrides.connState ?? 'connected',
      showAgentSessionHistoryAction: true,
      showChecksAction: true,
      activePanel: null
    })
    const tabDetails: SessionTitleCard['tabDetails'] = {
      barRef: useRef(null),
      boundaryRefs: useRef([]),
      dismiss: () => {},
      refreshSource: () => {},
      registerSource: () => () => {},
      toggleSource: () => {},
      activeKey: undefined,
      requestedKey: null
    }
    const details = mountFixture<SessionTitleCard>({
      tabDetails,
      besideTabs: true,
      barRef: tabDetails.barRef,
      backRef: useRef(null),
      openerRef: useRef(null),
      titleRef: useRef(null),
      boundaryRefs: useRef([]),
      active: false,
      requestedOpen: false,
      closeFirst: () => false,
      onAnchorLayout: () => {},
      toggle: () => {}
    })
    return createElement(
      'Screen',
      null,
      createElement(MobileSessionHeader, { controller, details }),
      createElement(MobileSessionTerminalLayoutSheet, {
        controller,
        visible: showTerminalLayout,
        onClose: () => setShowTerminalLayout(false)
      })
    )
  }
  act(() => {
    tree = create(createElement(Screen), {
      createNodeMock: () => ({
        measureInWindow: (done: (x: number, y: number, w: number, h: number) => void) =>
          done(330, 8, 36, 36)
      })
    })
  })
  return callbacks
}
const native = (type: string) => tree!.root.findAll((node) => String(node.type) === type)
function pressAction(label: string) {
  const row = native('Pressable').find(
    (node) =>
      node.findAll((text) => String(text.type) === 'Text' && text.props.children === label).length >
      0
  )!
  act(() => row.props.onPress())
}
function openMore() {
  act(() =>
    native('Pressable')
      .find((node) => node.props.accessibilityLabel === 'More session actions')!
      .props.onPress()
  )
}
function finishMenuClose() {
  act(() => frames.splice(0).forEach((frame) => frame(0)))
}

it('keeps tabs usable through narrow/wide changes and opens collapsed actions after the pull-down closes', () => {
  const callbacks = mountHeader()
  const originalTabs = native('Pressable').filter((node) => node.props.accessibilityRole === 'tab')
  expect(
    native('Pressable')
      .filter((node) => node.props.accessibilityRole === 'button')
      .map((node) => node.props.accessibilityLabel)
  ).toEqual(['Back to worktrees', 'More session actions'])
  act(() => originalTabs[1].props.onPress())
  expect(originalTabs[1].props.accessibilityState.selected).toBe(true)
  const header = native('View').find(
    (node) =>
      node.props.onLayout &&
      node.props.ref === tree!.root.findByType(MobileSessionHeader).props.details.barRef
  )!
  act(() => header.props.onLayout({ nativeEvent: { layout: { width: 927 } } }))
  expect(
    native('Pressable').find((node) => node.props.accessibilityLabel === 'New tab')
  ).toBeDefined()
  act(() => header.props.onLayout({ nativeEvent: { layout: { width: 382 } } }))
  expect(native('Pressable').filter((node) => node.props.accessibilityRole === 'tab')).toEqual(
    originalTabs
  )
  openMore()
  expect(native('Text').map((node) => node.props.children)).toContain('Agent History')
  expect(native('Text').map((node) => node.props.children)).toContain('Checks')
  expect(
    native('Pressable').filter((node) => node.props.accessibilityRole === 'menuitem')
  ).not.toEqual([])
  pressAction('Terminal layout')
  expect(native('Pressable').filter((node) => node.props.accessibilityRole === 'menuitem')).toEqual(
    []
  )
  expect(native('Drawer').map((node) => node.props.visible)).toEqual([false])
  finishMenuClose()
  expect(native('Drawer').map((node) => node.props.visible)).toEqual([true])
  pressAction('Side by side')
  expect(callbacks.setTerminalSplitLayout).toHaveBeenCalledWith('side-by-side')
  expect(callbacks.toggleTerminalSplit).toHaveBeenCalledOnce()
  openMore()
  pressAction('New tab')
  expect(callbacks.handleOpenNewTab).not.toHaveBeenCalled()
  finishMenuClose()
  expect(callbacks.handleOpenNewTab).toHaveBeenCalledOnce()
  openMore()
  pressAction('Quick commands')
  finishMenuClose()
  expect(callbacks.handleOpenQuickCommands).toHaveBeenCalledOnce()
  openMore()
  pressAction('File explorer')
  finishMenuClose()
  openMore()
  pressAction('Source control')
  finishMenuClose()
  expect(callbacks.handlePanelTap.mock.calls).toEqual([['files'], ['sourceControl']])
})

it.each([{ isFolderWorkspaceRoute: true }, { isFloatingWorkspaceRoute: true }])(
  'keeps workspace restrictions and connection gating in overflow (%j)',
  (route) => {
    mountHeader({ ...route, connState: 'disconnected' })
    openMore()
    const labels = native('Text').map((node) => node.props.children)
    expect(labels).not.toContain('Source control')
    expect(labels.includes('File explorer')).toBe(!('isFloatingWorkspaceRoute' in route))
    for (const label of ['New tab', 'Quick commands']) {
      const row = native('Pressable').find(
        (node) =>
          node.findAll((text) => String(text.type) === 'Text' && text.props.children === label)
            .length > 0
      )!
      expect(row.props.disabled).toBe(true)
    }
  }
)
