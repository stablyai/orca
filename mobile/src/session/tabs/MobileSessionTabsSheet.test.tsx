import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileSessionController } from '../use-mobile-session-controller'
import type { MobileSessionTabSummary } from './mobile-session-tab-rows'

vi.mock('react-native', async () => {
  const { createElement: h } = await import('react')
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    // Calls a render-function child the way the real Pressable does, so rows draw.
    Pressable: ({
      children,
      ...props
    }: {
      children?: ReactNode | ((state: { pressed: boolean }) => ReactNode)
    }) =>
      h(
        'Pressable',
        props,
        typeof children === 'function' ? children({ pressed: false }) : children
      ),
    StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} },
    Text: 'Text',
    View: 'View'
  }
})
vi.mock('lucide-react-native', () => ({ Plus: 'Plus', X: 'X' }))
// Like the real drawer, draws its content only while presented.
vi.mock('../../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null
}))
vi.mock('../../components/SwipeRowActions', () => ({
  SwipeRowActions: ({
    children
  }: {
    children: (guard: (onPress: () => void) => () => void) => ReactNode
  }) => children((onPress) => onPress)
}))
vi.mock('../../components/list/ListGroup', () => ({
  ListGroup: ({ children }: { children: ReactNode }) => children,
  SectionHeader: 'SectionHeader'
}))
vi.mock('../../components/AgentStateDot', () => ({ AgentStateDot: 'AgentStateDot' }))
vi.mock('../../components/nav-bar/NavBarButton', () => ({ NavBarButton: 'NavBarButton' }))
vi.mock('../../components/nav-bar/SheetHeader', () => ({ SheetHeader: 'SheetHeader' }))
vi.mock('./MobileSessionTabMark', () => ({ MobileSessionTabMark: 'MobileSessionTabMark' }))

const { MobileSessionTabsSheet } = await import('./MobileSessionTabsSheet')

const NOW = 1_700_000_000_000

function terminalTab(id: string, stateStartedAt: number): MobileSessionTabSummary {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sheet reads only these status fields; the rest of the host's status entry is unused here.
  return {
    tab: {
      type: 'terminal',
      id,
      title: id,
      isActive: false,
      terminal: null,
      agentStatus: {
        state: 'waiting',
        prompt: 'Fix the bug',
        updatedAt: stateStartedAt,
        stateStartedAt
      }
    },
    title: id,
    agentId: null,
    dotState: 'waiting',
    group: 'needs-you'
  } as unknown as MobileSessionTabSummary
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sheet reads only these controller members.
const controller = {
  activeSessionTabId: 'open-tab',
  worktreeName: 'main',
  switchSessionTab: () => {},
  handleCloseSessionTab: async () => {},
  handleOpenNewTab: () => {},
  createTabBusy: false,
  connState: 'connected'
} as unknown as MobileSessionController

describe('MobileSessionTabsSheet', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it('shows how long ago each tab changed as of opening, not as of when the bar mounted', () => {
    const tabs = [terminalTab('open-tab', NOW), terminalTab('other-tab', NOW - 30_000)]
    const sheet = (visible: boolean) =>
      createElement(MobileSessionTabsSheet, { controller, tabs, visible, onClose: () => {} })
    act(() => {
      renderer = create(sheet(false))
    })
    // Opened 45 s later, before any minute tick: the other tab changed 75 s ago.
    act(() => {
      vi.advanceTimersByTime(45_000)
    })
    act(() => renderer!.update(sheet(true)))

    const otherRow = renderer!.root.find(
      (node) =>
        String(node.type) === 'Pressable' && node.props.accessibilityState?.selected === false
    )
    const times = otherRow
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => node.props.children)
    expect(times).toContain('1m')
  })
})
