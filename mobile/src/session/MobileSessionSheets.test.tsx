import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { Pressable, Text } from 'react-native'
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
vi.mock('../components/BottomDrawer', () => ({
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
vi.mock('./MobileSessionHeaderMoreActionsSheet', () => ({
  MobileSessionHeaderMoreActionsSheet: () => null
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

describe('MobileSessionHeaderMoreActionsSheet', () => {
  it('renders recent cards above Agent History and selects the tapped card', async () => {
    const { MobileSessionHeaderMoreActionsSheet } = await vi.importActual<
      typeof import('./MobileSessionHeaderMoreActionsSheet')
    >('./MobileSessionHeaderMoreActionsSheet')
    const notes: RecentSessionCardRecord = {
      hostId: 'host-1',
      worktreeId: 'wt-1',
      worktreeName: 'Orca',
      tabId: 'tab-1',
      tabType: 'markdown',
      title: 'Ship notes',
      lastVisitedAt: NOW - 5 * 60_000
    }
    const onSelectRecentSessionCard = vi.fn()
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(
        createElement(MobileSessionHeaderMoreActionsSheet, {
          visible: true,
          showRecentSessionCards: true,
          recentSessionCards: [notes],
          onSelectRecentSessionCard,
          showAgentSessionHistory: true,
          showChecks: true,
          onOpenAgentSessionHistory: () => {},
          onOpenChecks: () => {},
          onClose: () => {}
        })
      )
    })
    if (renderer === null) {
      throw new Error('nothing mounted')
    }
    const labels = texts(renderer)
    expect(labels.indexOf('Ship notes')).toBeGreaterThanOrEqual(0)
    expect(labels.indexOf('Ship notes')).toBeLessThan(labels.indexOf('Agent History'))
    expect(renderer.root.findAllByType(Pressable).map((node) => textOf(node))).not.toContain(
      'Recently Used'
    )
    await act(async () => {
      renderer?.root.findByProps({ testID: 'recent-session-card-wt-1-tab-1' }).props.onPress()
    })
    expect(onSelectRecentSessionCard).toHaveBeenCalledExactlyOnceWith(notes)
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
