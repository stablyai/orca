import { createElement, type ReactElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Pressable, Text } from 'react-native'
import { MobileSessionHeaderMoreActionsSheet } from './MobileSessionHeaderMoreActionsSheet'
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

vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null
}))

vi.mock('../hooks/use-now', () => ({
  useNow: () => NOW
}))

vi.mock('../agent-history/MobileAgentSessionHistoryIcon', () => ({
  MobileAgentSessionHistoryIcon: () => null
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

function pressableLabels(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Pressable).map((node) => textOf(node))
}

describe('MobileSessionHeaderMoreActionsSheet', () => {
  function renderMenu(
    recentSessionCards: readonly RecentSessionCardRecord[],
    showRecent = true,
    onSelectRecentSessionCard: (card: RecentSessionCardRecord) => void = () => {}
  ) {
    return mount(
      createElement(MobileSessionHeaderMoreActionsSheet, {
        visible: true,
        showRecentSessionCards: showRecent,
        recentSessionCards,
        onSelectRecentSessionCard,
        showAgentSessionHistory: true,
        showChecks: true,
        onOpenAgentSessionHistory: () => {},
        onOpenChecks: () => {},
        onClose: () => {}
      })
    )
  }

  it('renders recent cards above Agent History without a nested Recently Used row', () => {
    const tree = renderMenu([notes, shell])
    const labels = texts(tree)
    expect(labels.indexOf('Recently Used')).toBeGreaterThanOrEqual(0)
    expect(labels.indexOf('Ship notes')).toBeLessThan(labels.indexOf('Agent History'))
    expect(labels.indexOf('Shell')).toBeLessThan(labels.indexOf('Agent History'))
    expect(pressableLabels(tree)).not.toContain('Recently Used')
    expect(tree.root.findByProps({ testID: 'recent-session-card-wt-1-tab-1' })).toBeTruthy()
    expect(tree.root.findByProps({ testID: 'recent-session-card-wt-2-tab-2' })).toBeTruthy()
  })

  it('selects a recent card from the same sheet', () => {
    const onSelectRecentSessionCard = vi.fn()
    const tree = renderMenu([notes], true, onSelectRecentSessionCard)
    act(() => {
      tree.root.findByProps({ testID: 'recent-session-card-wt-1-tab-1' }).props.onPress()
    })
    expect(onSelectRecentSessionCard).toHaveBeenCalledExactlyOnceWith(notes)
  })

  it('shows an empty recent list above Agent History', () => {
    const labels = texts(renderMenu([]))
    expect(labels.indexOf('Recently Used')).toBeGreaterThanOrEqual(0)
    expect(labels.indexOf('No other recent cards yet')).toBeLessThan(
      labels.indexOf('Agent History')
    )
  })

  it('hides the currently open card, marks same-workspace cards with a badge dot, and renders SSOT AgentStateDot indicators', () => {
    const activeCard = card({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      title: 'Ship notes',
      lastVisitedAt: NOW
    })
    const tree = mount(
      createElement(MobileSessionHeaderMoreActionsSheet, {
        visible: true,
        showRecentSessionCards: true,
        recentSessionCards: [
          activeCard,
          card({
            worktreeId: 'wt-1',
            tabId: 'tab-3',
            title: 'Other notes',
            agentState: 'working',
            lastVisitedAt: NOW - 10 * 60 * 1_000
          }),
          { ...shell, agentState: 'done' }
        ],
        currentWorktreeId: 'wt-1',
        currentTabId: 'tab-1',
        onSelectRecentSessionCard: () => {},
        showAgentSessionHistory: true,
        showChecks: true,
        onOpenAgentSessionHistory: () => {},
        onOpenChecks: () => {},
        onClose: () => {}
      })
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

  it('truncates long workspace branch names by abbreviating prefix before slash and keeping tail after slash', () => {
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
    const tree = renderMenu([longBranchCard])
    expect(texts(tree)).toContain('z/…history-stack')
    expect(
      tree.root.findByProps({ testID: 'recent-session-card-wt-long-tab-long' }).props
        .accessibilityLabel
    ).toBe('Verify PRs, zhangxaochen/mobile-agent-history-stack, 5m')
  })

  it('hides Recently Used until the screen offers it', () => {
    const tree = renderMenu([notes], false)
    const labels = texts(tree)
    expect(labels).not.toContain('Recently Used')
    expect(labels).not.toContain('Ship notes')
    expect(labels.indexOf('Agent History')).toBeGreaterThanOrEqual(0)
    expect(
      tree.root.findAll((node) =>
        String(node.props?.testID ?? '').startsWith('recent-session-card-')
      )
    ).toHaveLength(0)
  })
})

describe('RecentSessionCardsSheet', () => {
  it('shows the card title and workspace, selects that card, and adjusts maxDisplay', () => {
    const onSelectCard = vi.fn()
    const onChangeMaxDisplay = vi.fn()
    const tree = mount(
      createElement(RecentSessionCardsSheet, {
        visible: true,
        cards: [notes],
        jumpingCardKey: null,
        maxDisplay: 7,
        onChangeMaxDisplay,
        onSelectCard,
        onClose: () => {}
      })
    )
    const labels = texts(tree)
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
    const tree = mount(
      createElement(RecentSessionCardsSheet, {
        visible: true,
        cards: [],
        jumpingCardKey: null,
        onSelectCard: () => {},
        onClose: () => {}
      })
    )
    expect(texts(tree)).toContain('No other recent cards yet')
  })
})
