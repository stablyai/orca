import { createElement, type ReactElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Text } from 'react-native'
import { formatWorkspaceBadgeLabel, RecentSessionCardsSheet } from './RecentSessionCardsSheet'
import type { RecentSessionCardRecord } from './recent-session-cards'

const NOW = 1_700_000_000_000

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: {
    create: (styles: unknown) => styles,
    hairlineWidth: 1
  },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  File: 'File',
  FileText: 'FileText',
  Globe: 'Globe',
  Edit3: 'Edit3',
  History: 'History',
  ListChecks: 'ListChecks',
  ArrowUpRight: 'ArrowUpRight',
  Minus: 'Minus',
  Plus: 'Plus',
  SquareTerminal: 'SquareTerminal',
  Trash2: 'Trash2'
}))

vi.mock('../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null
}))

vi.mock('../hooks/use-now', () => ({
  useNow: () => NOW
}))

vi.mock('../components/MobileAgentIcon', () => ({
  MobileAgentIcon: () => null
}))

vi.mock('../components/AgentStateDot', () => ({
  AgentStateDot: ({ state }: { state?: string }) =>
    state && state !== 'idle' ? createElement('AgentStateDot', { state }) : null,
  agentStateLabel: (state: string) =>
    state === 'working'
      ? 'Working'
      : state === 'done'
        ? 'Done'
        : state === 'waiting'
          ? 'Waiting for input'
          : ''
}))

function card(
  overrides: Partial<RecentSessionCardRecord> &
    Pick<RecentSessionCardRecord, 'worktreeId' | 'tabId' | 'title'>
): RecentSessionCardRecord {
  return {
    hostId: 'host-1',
    worktreeName: 'Orca',
    tabType: 'markdown',
    lastVisitedAt: NOW - 5 * 60_000,
    ...overrides
  }
}

const notes = card({ worktreeId: 'wt-1', tabId: 'tab-1', title: 'Ship notes' })
const shell = card({
  worktreeId: 'wt-2',
  tabId: 'tab-2',
  title: 'Shell',
  tabType: 'terminal',
  worktreeName: 'Tools'
})

function texts(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((node) => textOf(node))
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
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

afterEach(() => {
  vi.clearAllMocks()
})

describe('RecentSessionCardsSheet', () => {
  function renderSheet(
    cards: readonly RecentSessionCardRecord[],
    extras: {
      visible?: boolean
      currentWorktreeId?: string
      currentTabId?: string | null
      maxDisplay?: number
      onChangeMaxDisplay?: (next: number) => void
      onSelectCard?: (card: RecentSessionCardRecord) => void
    } = {}
  ) {
    const { onSelectCard = () => {}, visible = true, ...rest } = extras
    return mount(
      createElement(RecentSessionCardsSheet, {
        visible,
        cards,
        jumpingCardKey: null,
        onSelectCard,
        onClose: () => {},
        ...rest
      })
    )
  }

  it('shows the card title and workspace, selects that card, and adjusts maxDisplay', () => {
    const onSelectCard = vi.fn()
    const onChangeMaxDisplay = vi.fn()
    const tree = renderSheet([notes], { maxDisplay: 7, onChangeMaxDisplay, onSelectCard })
    const labels = texts(tree)
    expect(labels).toContain('Recently Used')
    expect(labels).toContain('Ship notes')
    expect(labels).toContain('Orca')
    expect(labels).toContain('5m')
    expect(textOf(tree.root.findByProps({ testID: 'recent-cards-limit-value' }))).toBe('7')
    act(() => {
      tree.root.findByProps({ testID: 'recent-cards-limit-increase' }).props.onPress()
    })
    expect(onChangeMaxDisplay).toHaveBeenCalledWith(8)
    act(() => {
      tree.root.findByProps({ testID: 'recent-session-card-wt-1-tab-1' }).props.onPress()
    })
    expect(onSelectCard).toHaveBeenCalledExactlyOnceWith(notes)
  })

  it('shows an empty state when no other card is recent', () => {
    expect(texts(renderSheet([]))).toContain('No other recent cards yet')
  })

  it('hides the currently open card, marks same-workspace cards, and renders AgentStateDot states', () => {
    const tree = renderSheet(
      [
        card({
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          title: 'Ship notes',
          lastVisitedAt: NOW
        }),
        card({
          worktreeId: 'wt-1',
          tabId: 'tab-3',
          title: 'Other notes',
          agentState: 'working',
          lastVisitedAt: NOW - 10 * 60 * 1_000
        }),
        { ...shell, agentState: 'done' }
      ],
      { currentWorktreeId: 'wt-1', currentTabId: 'tab-1' }
    )
    expect(tree.root.findAllByProps({ testID: 'recent-session-card-wt-1-tab-1' })).toHaveLength(0)
    expect(
      tree.root.findByProps({ testID: 'recent-session-card-current-workspace-wt-1-tab-3' })
    ).toBeTruthy()
    expect(
      tree.root.findAllByProps({ testID: 'recent-session-card-current-workspace-wt-2-tab-2' })
    ).toHaveLength(0)
    expect(
      tree.root.findByProps({ testID: 'recent-session-card-state-dot-wt-1-tab-3' })
    ).toBeTruthy()
    expect(
      tree.root.findByProps({ testID: 'recent-session-card-state-dot-wt-2-tab-2' })
    ).toBeTruthy()
    expect(
      tree.root
        .findAll((node) => String(node.type) === 'AgentStateDot')
        .map((node) => node.props.state)
    ).toEqual(['working', 'done'])
    expect(texts(tree)).not.toContain('Ship notes')
    expect(texts(tree)).toContain('10m')
    expect(texts(tree)).toContain('5m')
    expect(
      tree.root.findByProps({ testID: 'recent-session-card-wt-1-tab-3' }).props.accessibilityLabel
    ).toBe('Other notes, Working, Orca, 10m')
    expect(
      tree.root.findByProps({ testID: 'recent-session-card-wt-2-tab-2' }).props.accessibilityLabel
    ).toBe('Shell, Done, Tools, 5m')
  })

  it('truncates long workspace branch names by abbreviating the prefix and keeping the tail', () => {
    expect(formatWorkspaceBadgeLabel('main')).toBe('main')
    expect(formatWorkspaceBadgeLabel('zhangxaochen/fix-ui')).toBe('z/fix-ui')
    expect(formatWorkspaceBadgeLabel('zhangxaochen/mobile-agent-history-stack')).toBe(
      'z/…history-stack'
    )
    expect(formatWorkspaceBadgeLabel('local/verify-active-prs')).toBe('l/…fy-active-prs')
    expect(formatWorkspaceBadgeLabel('mobile-agent-history-stack')).toBe('…t-history-stack')

    const longBranchCard = card({
      worktreeId: 'wt-long',
      tabId: 'tab-long',
      title: 'Verify PRs',
      worktreeName: 'zhangxaochen/mobile-agent-history-stack'
    })
    const tree = renderSheet([longBranchCard])
    expect(texts(tree)).toContain('z/…history-stack')
    expect(
      tree.root.findByProps({ testID: 'recent-session-card-wt-long-tab-long' }).props
        .accessibilityLabel
    ).toBe('Verify PRs, zhangxaochen/mobile-agent-history-stack, 5m')
  })

  it('renders nothing while closed', () => {
    expect(renderSheet([notes], { visible: false }).toJSON()).toBeNull()
  })
})
