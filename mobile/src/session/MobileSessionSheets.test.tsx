import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { Text } from 'react-native'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { RecentSessionCardRecord } from './recent-session-cards'

const sheets = vi.hoisted(() => ({ labelsByTitle: new Map<string, string[]>() }))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: {
    create: (styles: unknown) => styles,
    hairlineWidth: 1
  },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Copy: 'Icon',
  File: 'Icon',
  FileText: 'Icon',
  Globe: 'Icon',
  ArrowUpRight: 'Icon',
  ListChecks: 'Icon',
  LocateFixed: 'Icon',
  Minus: 'Icon',
  Plus: 'Icon',
  RefreshCw: 'Icon',
  SquareTerminal: 'Icon'
}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({}) }))
vi.mock('../platform/haptics', () => ({ triggerSuccess: () => {}, triggerError: () => {} }))
vi.mock('../hooks/use-now', () => ({ useNow: () => 1_700_000_000_000 }))
vi.mock('../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null
}))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../agent-history/MobileAgentSessionHistoryIcon', () => ({
  MobileAgentSessionHistoryIcon: () => null
}))
vi.mock('../components/ActionSheetModal', async () => {
  const { createElement: createNode } = await import('react')
  return {
    ActionSheetModal: ({
      title,
      actions,
      children
    }: {
      title?: string
      actions: ActionSheetAction[]
      children?: ReactNode
    }) => {
      sheets.labelsByTitle.set(
        title ?? '',
        actions.map((action) => action.label)
      )
      return createNode(
        'View',
        null,
        children,
        ...actions.map((action) => createNode('Text', { key: action.label }, action.label))
      )
    }
  }
})
vi.mock('../components/TextInputModal', () => ({ TextInputModal: () => null }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('../components/CustomKeyModal', () => ({ CustomKeyModal: () => null }))
vi.mock('../components/MobileDictationSetupSheet', () => ({
  MobileDictationSetupSheet: () => null
}))
vi.mock('./MobileSessionTerminalLayoutSheet', () => ({
  MobileSessionTerminalLayoutSheet: () => null
}))
vi.mock('./QuickCommandsSheet', () => ({ QuickCommandsSheet: () => null }))
vi.mock('./MobileBrowserTabActionSheet', () => ({ MobileBrowserTabActionSheet: () => null }))
vi.mock('./mobile-terminal-action-sheet-actions', () => ({
  getMobileTerminalActionSheetActions: () => []
}))

import { MobileSessionSheets } from './MobileSessionSheets'

async function newTabLabels(executionHost?: string): Promise<string[]> {
  sheets.labelsByTitle.clear()
  const controller = mountFixture<Parameters<typeof MobileSessionSheets>[0]['controller']>({
    worktreeId: 'repo::/wt',
    isFolderWorkspaceRoute: false,
    isFloatingWorkspaceRoute: false,
    sessionTabs: [],
    nativeChatController: { isTabChatView: () => false },
    createTabAgentActions: [],
    sendDiffNotesAgentActions: [],
    closeWithBulkActions: () => []
  })
  await act(async () => {
    create(
      createElement(
        WorkspaceExecutionHostContext.Provider,
        { value: normalizeExecutionHostId(executionHost) ?? undefined },
        createElement(MobileSessionSheets, { controller })
      )
    )
  })
  return sheets.labelsByTitle.get('New Tab') ?? []
}

const NOW = 1_700_000_000_000

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
}

function texts(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((node) => textOf(node))
}

describe('RecentSessionCardsSheet from MobileSessionSheets', () => {
  const notes: RecentSessionCardRecord = {
    hostId: 'host-1',
    worktreeId: 'wt-1',
    worktreeName: 'Orca',
    tabId: 'tab-1',
    tabType: 'markdown',
    title: 'Ship notes',
    lastVisitedAt: NOW - 5 * 60_000
  }

  async function mountSheets(showRecentSessionCards: boolean, showHeaderMoreActions = false) {
    const handleSelectRecentSessionCard = vi.fn()
    const controller = mountFixture<Parameters<typeof MobileSessionSheets>[0]['controller']>({
      worktreeId: 'repo::/wt',
      activeSessionTabId: 'tab-other',
      isFolderWorkspaceRoute: false,
      isFloatingWorkspaceRoute: false,
      sessionTabs: [],
      nativeChatController: { isTabChatView: () => false },
      createTabAgentActions: [],
      sendDiffNotesAgentActions: [],
      closeWithBulkActions: () => [],
      showRecentSessionCards,
      showRecentSessionCardsAction: true,
      showHeaderMoreActions,
      recentSessionCards: [notes],
      jumpingRecentCardKey: null,
      handleSelectRecentSessionCard,
      setShowRecentSessionCards: () => {}
    })
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(createElement(MobileSessionSheets, { controller }))
    })
    if (renderer === null) {
      throw new Error('nothing mounted')
    }
    return { renderer, handleSelectRecentSessionCard }
  }

  it('renders recent cards and selects the tapped card', async () => {
    const { renderer, handleSelectRecentSessionCard } = await mountSheets(true)
    expect(texts(renderer)).toContain('Ship notes')
    await act(async () => {
      renderer.root.findByProps({ testID: 'recent-session-card-wt-1-tab-1' }).props.onPress()
    })
    expect(handleSelectRecentSessionCard).toHaveBeenCalledExactlyOnceWith(notes)
  })

  it('keeps recent cards hidden when the sheet is closed even if the header menu is open', async () => {
    const { renderer } = await mountSheets(false, true)
    expect(texts(renderer)).not.toContain('Ship notes')
    expect(renderer.root.findAllByProps({ testID: 'recent-session-card-wt-1-tab-1' })).toHaveLength(
      0
    )
  })
})

describe('the New Tab sheet', () => {
  it('offers Markdown Note for a workspace the desktop hosts', async () => {
    expect(await newTabLabels()).toContain('Markdown Note')
  })

  it('leaves out Markdown Note for a server workspace, whose host opens no editor tabs', async () => {
    const labels = await newTabLabels('runtime:vm')
    expect(labels).toEqual(['Terminal', 'Browser'])
  })
})
