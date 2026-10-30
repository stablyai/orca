import { createElement } from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

// Mocked react-native components are string tags that ReactTestInstance's ElementType omits.
function hostType(node: ReactTestInstance): unknown {
  return node.type
}

const layout = vi.hoisted(() => ({ isLandscapePhone: false }))

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (map: Record<string, unknown>) => map.ios ?? map.default },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  File: 'Icon',
  FileText: 'Icon',
  Folder: 'Icon',
  GitBranch: 'Icon',
  Globe: 'Icon',
  MoreHorizontal: 'Icon',
  PanelLeftOpen: 'Icon',
  Plus: 'Icon',
  SquareChevronRight: 'Icon'
}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: () => {} }))
vi.mock('../components/StatusDot', () => ({ StatusDot: 'StatusDot' }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('../platform/keyboard-persisting-taps', () => ({
  useKeyboardPersistingTaps: () => undefined
}))
vi.mock('../layout/host-sidebar-reveal', () => ({ useHostSidebarReveal: () => null }))
vi.mock('../layout/responsive-layout', () => ({ useResponsiveLayout: () => layout }))

import { MobileSessionHeader } from './MobileSessionHeader'
import type { MobileDesktopTabTitle } from './mobile-desktop-tab-titles'
import type { MobileSessionController } from './use-mobile-session-controller'

type Tabs = MobileSessionController['visibleTabs']

function cursorTab(
  title: string,
  extra: { launchAgent?: 'cursor'; parentTabId?: string; leafId?: string } = {}
): Tabs {
  return [
    { type: 'terminal', id: 'tab-0', title, terminal: 'cursor-pty', isActive: true, ...extra }
  ]
}

function renderHeader(desktopTabTitles?: ReadonlyMap<string, MobileDesktopTabTitle>) {
  const controller: Partial<MobileSessionController> = {
    hostId: 'host-1',
    worktreeId: 'workspace-1',
    desktopTabTitles,
    connState: 'connected',
    worktreeName: 'workspace',
    terminalSummary: '',
    handlePanelTap: () => {},
    setShowHeaderMoreActions: () => {},
    requestLeaveSession: () => {},
    activeSessionTabId: 'tab-0',
    activeSessionTabIdRef: { current: 'tab-0' },
    tabStripRef: { current: null },
    tabStripOffsetRef: { current: 0 },
    tabStripViewportWidthRef: { current: 0 },
    tabStripContentWidthRef: { current: 0 },
    tabLayoutsRef: { current: new Map() },
    scrollActiveTabIntoView: () => {},
    switchSessionTab: () => {},
    openSessionTabActionSheetAfterKeyboardDismiss: () => {},
    visibleTabs: []
  }
  const element = () =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every controller field the header and tab strip read.
    createElement(MobileSessionHeader, { controller: controller as MobileSessionController })
  let renderer: ReturnType<typeof create> | undefined
  act(() => {
    renderer = create(element())
  })
  if (!renderer) {
    throw new Error('header did not render')
  }
  const mounted = renderer
  return {
    update(tabs: Tabs) {
      controller.visibleTabs = tabs
      act(() => mounted.update(element()))
    },
    // Why: tab presses carry the long-press delay; the header's other buttons do not.
    tabTitles: () =>
      mounted.root
        .findAll((node) => hostType(node) === 'Pressable' && node.props.delayLongPress === 400)
        .map((tab) =>
          tab
            .findAll((node: ReactTestInstance) => hostType(node) === 'Text')
            .map((text) => text.children.join(''))
            .join('')
        ),
    unmount: () => act(() => mounted.unmount())
  }
}

describe('MobileSessionHeader Cursor tab titles', () => {
  it('shows the saved desktop task name when Cursor only publishes its generic title', () => {
    const header = renderHeader(
      new Map([
        [
          'cursor-pty',
          { title: 'Saved task name', tabId: 'tab-0', leafId: 'leaf-0', agentIdentity: 'cursor' }
        ]
      ])
    )
    header.update(cursorTab('⠋ Cursor Agent', { parentTabId: 'tab-0', leafId: 'leaf-0' }))
    expect(header.tabTitles()).toEqual(['Saved task name'])
    header.unmount()
  })

  it('keeps the rendered Cursor title stable through status frames', () => {
    const header = renderHeader()
    header.update(cursorTab('Cursor title regression - ⏳ Working ...', { launchAgent: 'cursor' }))
    for (const title of [
      '⠋ Cursor Agent',
      'Cursor title regression - ⏳ Working ···',
      'Cursor ready'
    ]) {
      header.update(cursorTab(title, { launchAgent: 'cursor' }))
      expect(header.tabTitles()).toEqual(['Cursor title regression'])
    }
    header.update(cursorTab('Manually renamed', { launchAgent: 'cursor' }))
    header.update(cursorTab('⠹ Cursor Agent', { launchAgent: 'cursor' }))
    expect(header.tabTitles()).toEqual(['Manually renamed'])
    header.unmount()
  })

  it('keeps the Cursor task name when the strip moves into the top bar', () => {
    layout.isLandscapePhone = false
    const header = renderHeader()
    header.update(cursorTab('Rotate me - ⏳ Working ...', { launchAgent: 'cursor' }))
    layout.isLandscapePhone = true
    header.update(cursorTab('⠋ Cursor Agent', { launchAgent: 'cursor' }))
    expect(header.tabTitles()).toEqual(['Rotate me'])
    layout.isLandscapePhone = false
    header.unmount()
  })
})
