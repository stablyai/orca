import { createElement, type ReactElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSessionTabsSheet } from './MobileSessionTabsSheet'
import type { MobileSessionTabSummary } from './mobile-session-tab-rows'

const NOW = 1_700_000_000_000

vi.mock('react-native', () => ({
  Image: 'Image',
  Pressable: ({
    children,
    ...props
  }: Record<string, unknown> & {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode)
  }) =>
    createElement(
      'Pressable',
      props,
      typeof children === 'function' ? children({ pressed: false }) : children
    ),
  StyleSheet: {
    create: (styles: unknown) => styles
  },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Bell: 'Bell',
  File: 'File',
  FileText: 'FileText',
  Globe: 'Globe',
  Plus: 'Plus',
  SquareTerminal: 'SquareTerminal',
  X: 'X'
}))

vi.mock('../../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null
}))

vi.mock('../../components/list/ListGroup', () => ({
  ListGroup: ({ children }: { children: ReactNode }) => children,
  SectionHeader: 'SectionHeader'
}))

vi.mock('../../components/nav-bar/NavBarButton', () => ({
  NavBarButton: 'NavBarButton'
}))

vi.mock('../../components/nav-bar/SheetHeader', () => ({
  SheetHeader: 'SheetHeader'
}))

vi.mock('../../components/list/SwipeRowActions', () => ({
  SwipeRowActions: ({
    children
  }: {
    children: (guardPress: (action: () => void) => () => void) => ReactNode
  }) => children((action) => action)
}))

vi.mock('../../agents/presentation/AgentStateDot', () => ({
  AgentStateDot: ({ state }: { state?: string }) =>
    state && state !== 'idle' ? createElement('AgentStateDot', { state }) : null
}))

vi.mock('../../components/icons/MobileAgentIcon', () => ({
  MobileAgentIcon: ({ agentId, size }: { agentId: string; size: number }) =>
    createElement('MobileAgentIcon', { agentId, size })
}))

vi.mock('../../hooks/use-now', () => ({
  useNow: () => NOW
}))

vi.mock('../fork/MobileForkMarkedName', () => ({
  MobileForkMarkedName: ({ name }: { name: string }) => name
}))

function terminalSummary({
  id,
  title,
  agentId,
  dotState,
  group,
  unread
}: {
  id: string
  title: string
  agentId: string | null
  dotState: MobileSessionTabSummary['dotState']
  group: MobileSessionTabSummary['group']
  unread: boolean
}): MobileSessionTabSummary {
  return {
    tab: {
      type: 'terminal',
      id,
      title,
      isActive: false,
      terminal: null,
      ...(unread ? { unread: true } : {})
    },
    title,
    agentId,
    dotState,
    group,
    unread
  }
}

function mount(node: ReactElement): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(node)
  })
  if (renderer === null) {
    throw new Error('nothing mounted')
  }
  return renderer
}

function findRow(tree: ReactTestRenderer, title: string): ReactTestInstance {
  return tree.root.find(
    (node) =>
      String(node.type) === 'Pressable' &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(`${title},`)
  )
}

describe('MobileSessionTabsSheet unread badge', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('keeps the real tab/agent icon in the tile and shows the 10px unread bell in the corner badge', () => {
    const controller = {
      activeSessionTabId: 'tab-active',
      worktreeName: 'orca',
      switchSessionTab: () => {},
      handleCloseSessionTab: async () => {},
      createTabBusy: false,
      connState: 'connected' as const,
      handleOpenNewTab: () => {}
    }

    const tabs: MobileSessionTabSummary[] = [
      terminalSummary({
        id: 'tab-unread-done',
        title: 'Claude done',
        agentId: 'claude',
        dotState: 'done',
        group: 'other',
        unread: true
      }),
      terminalSummary({
        id: 'tab-read-done',
        title: 'Codex done',
        agentId: 'codex',
        dotState: 'done',
        group: 'other',
        unread: false
      }),
      terminalSummary({
        id: 'tab-unread-working',
        title: 'Claude working',
        agentId: 'claude',
        dotState: 'working',
        group: 'working',
        unread: true
      }),
      terminalSummary({
        id: 'tab-unread-waiting',
        title: 'Claude waiting',
        agentId: 'claude',
        dotState: 'waiting',
        group: 'needs-you',
        unread: true
      }),
      terminalSummary({
        id: 'tab-unread-idle',
        title: 'Unread shell',
        agentId: null,
        dotState: undefined,
        group: 'other',
        unread: true
      })
    ]

    renderer = mount(
      createElement(MobileSessionTabsSheet, {
        controller,
        tabs,
        visible: true,
        onClose: () => {}
      })
    )

    const unreadDoneRow = findRow(renderer, 'Claude done')
    expect(
      unreadDoneRow
        .findAll((n) => String(n.type) === 'MobileAgentIcon')
        .map((n) => ({ agentId: n.props.agentId, size: n.props.size }))
    ).toEqual([{ agentId: 'claude', size: 17 }])
    expect(unreadDoneRow.findAll((n) => String(n.type) === 'Bell')).toHaveLength(1)
    const unreadDoneBadge = unreadDoneRow.findByProps({
      testID: 'session-tabs-sheet-badge-tab-unread-done'
    })
    expect(
      unreadDoneBadge.findAll((n) => String(n.type) === 'Bell').map((n) => n.props.size)
    ).toEqual([10])
    expect(unreadDoneBadge.findAll((n) => String(n.type) === 'AgentStateDot')).toHaveLength(0)

    const readDoneRow = findRow(renderer, 'Codex done')
    expect(
      readDoneRow
        .findAll((n) => String(n.type) === 'MobileAgentIcon')
        .map((n) => ({ agentId: n.props.agentId, size: n.props.size }))
    ).toEqual([{ agentId: 'codex', size: 17 }])
    const readDoneBadge = readDoneRow.findByProps({
      testID: 'session-tabs-sheet-badge-tab-read-done'
    })
    expect(readDoneBadge.findAll((n) => String(n.type) === 'Bell')).toHaveLength(0)
    expect(
      readDoneBadge.findAll((n) => String(n.type) === 'AgentStateDot').map((n) => n.props.state)
    ).toEqual(['done'])

    const workingRow = findRow(renderer, 'Claude working')
    expect(workingRow.findAll((n) => String(n.type) === 'MobileAgentIcon')).toHaveLength(1)
    const workingBadge = workingRow.findByProps({
      testID: 'session-tabs-sheet-badge-tab-unread-working'
    })
    expect(workingBadge.findAll((n) => String(n.type) === 'Bell')).toHaveLength(0)
    expect(
      workingBadge.findAll((n) => String(n.type) === 'AgentStateDot').map((n) => n.props.state)
    ).toEqual(['working'])

    const waitingRow = findRow(renderer, 'Claude waiting')
    expect(waitingRow.findAll((n) => String(n.type) === 'MobileAgentIcon')).toHaveLength(1)
    const waitingBadge = waitingRow.findByProps({
      testID: 'session-tabs-sheet-badge-tab-unread-waiting'
    })
    expect(waitingBadge.findAll((n) => String(n.type) === 'Bell')).toHaveLength(0)
    expect(
      waitingBadge.findAll((n) => String(n.type) === 'AgentStateDot').map((n) => n.props.state)
    ).toEqual(['waiting'])

    const unreadIdleRow = findRow(renderer, 'Unread shell')
    expect(
      unreadIdleRow.findAll((n) => String(n.type) === 'SquareTerminal').map((n) => n.props.size)
    ).toEqual([17])
    const unreadIdleBadge = unreadIdleRow.findByProps({
      testID: 'session-tabs-sheet-badge-tab-unread-idle'
    })
    expect(
      unreadIdleBadge.findAll((n) => String(n.type) === 'Bell').map((n) => n.props.size)
    ).toEqual([10])
  })
})
