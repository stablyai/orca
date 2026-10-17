import { createElement } from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (map: Record<string, unknown>) => map.android ?? map.default },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  Folder: 'Icon',
  File: 'Icon',
  FileText: 'Icon',
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

import { MobileSessionHeader } from './MobileSessionHeader'
import type { MobileSessionController } from './use-mobile-session-controller'

const TITLES = ['A', 'Build', 'Logs', 'Tasks', 'Notes']

function renderHeader(activeId: string) {
  const switchSessionTab = vi.fn()
  const openSessionTabActionSheetAfterKeyboardDismiss = vi.fn()
  const visibleTabs = TITLES.map((title, i) => ({ type: 'terminal', id: `tab-${i}`, title }))
  const controller: Partial<MobileSessionController> = {
    connState: 'connected',
    activeSessionTabId: activeId,
    activeSessionTabIdRef: { current: activeId },
    tabStripRef: { current: null },
    tabStripOffsetRef: { current: 0 },
    tabStripViewportWidthRef: { current: 0 },
    tabStripContentWidthRef: { current: 0 },
    tabLayoutsRef: { current: new Map() },
    scrollActiveTabIntoView: () => {},
    switchSessionTab,
    openSessionTabActionSheetAfterKeyboardDismiss,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal tabs with id and title are the only fields the strip reads here.
    visibleTabs: visibleTabs as MobileSessionController['visibleTabs']
  }
  let renderer: ReturnType<typeof create> | undefined
  act(() => {
    renderer = create(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every controller field the tab strip reads.
      createElement(MobileSessionHeader, { controller: controller as MobileSessionController })
    )
  })
  if (!renderer) {
    throw new Error('header did not render')
  }
  return { root: renderer.root, switchSessionTab, openSessionTabActionSheetAfterKeyboardDismiss }
}

const hasAncestorRole = (node: ReactTestInstance, role: string) => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.props.accessibilityRole === role) {
      return true
    }
  }
  return false
}

const tabsOf = (root: ReactTestInstance) =>
  root.findAll((node) => node.props.accessibilityRole === 'tab')

describe('MobileSessionHeader tab strip', () => {
  it('exposes each tab by its full title with only the active one selected', () => {
    const { root } = renderHeader('tab-3')
    const tabs = tabsOf(root)
    const selected = [false, false, false, true, false]
    expect(tabs.map((tab) => tab.props.accessibilityLabel)).toEqual(TITLES)
    expect(tabs.map((tab) => tab.props.accessibilityState.selected)).toEqual(selected)
    expect(tabs.map((tab) => tab.props['aria-selected'])).toEqual(selected)
  })

  it('groups the tabs inside one tablist', () => {
    const { root } = renderHeader('tab-0')
    const tabs = tabsOf(root)
    expect(root.findAll((node) => node.props.accessibilityRole === 'tablist')).toHaveLength(1)
    expect(tabs).toHaveLength(TITLES.length)
    expect(tabs.every((tab) => hasAncestorRole(tab, 'tablist'))).toBe(true)
  })

  it('hands the pressed and long-pressed tab to its handlers', () => {
    const { root, switchSessionTab, openSessionTabActionSheetAfterKeyboardDismiss } =
      renderHeader('tab-0')
    const tabs = tabsOf(root)
    act(() => tabs[4].props.onPress())
    act(() => tabs[2].props.onLongPress())
    expect(switchSessionTab).toHaveBeenCalledTimes(1)
    expect(switchSessionTab.mock.calls[0][0].id).toBe('tab-4')
    expect(openSessionTabActionSheetAfterKeyboardDismiss).toHaveBeenCalledTimes(1)
    expect(openSessionTabActionSheetAfterKeyboardDismiss.mock.calls[0][0].id).toBe('tab-2')
  })
})
