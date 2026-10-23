import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { ActionSheetAction } from '../components/ActionSheetModal'

const sheets = vi.hoisted(() => ({
  labelsByTitle: new Map<string, string[]>(),
  actionsByTitle: new Map<string, ActionSheetAction[]>(),
  clipboardWriteText: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('lucide-react-native', () => ({
  Copy: 'Icon',
  FileText: 'Icon',
  Globe: 'Icon',
  RefreshCw: 'Icon',
  SquareTerminal: 'Icon'
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: sheets.clipboardWriteText })
}))
vi.mock('../platform/haptics', () => ({ triggerSuccess: () => {}, triggerError: () => {} }))
vi.mock('../components/ActionSheetModal', () => ({
  ActionSheetModal: ({ title, actions }: { title: string; actions: ActionSheetAction[] }) => {
    sheets.labelsByTitle.set(
      title,
      actions.map((action) => action.label)
    )
    sheets.actionsByTitle.set(title, actions)
    return null
  }
}))
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

describe('the New Tab sheet', () => {
  it('offers Markdown Note for a workspace the desktop hosts', async () => {
    expect(await newTabLabels()).toContain('Markdown Note')
  })

  it('leaves out Markdown Note for a server workspace, whose host opens no editor tabs', async () => {
    const labels = await newTabLabels('runtime:vm')
    expect(labels).toEqual(['Terminal', 'Browser'])
  })

  it('copies the absolute filePath from the Markdown tab action sheet Copy Path action', async () => {
    sheets.actionsByTitle.clear()
    sheets.clipboardWriteText.mockClear()
    const controller = mountFixture<Parameters<typeof MobileSessionSheets>[0]['controller']>({
      worktreeId: 'repo::/wt',
      isFolderWorkspaceRoute: false,
      isFloatingWorkspaceRoute: false,
      sessionTabs: [],
      nativeChatController: { isTabChatView: () => false },
      createTabAgentActions: [],
      sendDiffNotesAgentActions: [],
      closeWithBulkActions: () => [],
      markdownActionTarget: {
        type: 'markdown',
        id: 'md-1',
        title: 'README.md',
        filePath: '/wt/README.md',
        relativePath: 'README.md',
        isDirty: false,
        isActive: true
      },
      setMarkdownActionTarget: vi.fn(),
      showToast: vi.fn()
    })
    await act(async () => {
      create(createElement(MobileSessionSheets, { controller }))
    })
    const copyPathAction = sheets.actionsByTitle
      .get('README.md')
      ?.find((action) => action.label === 'Copy Path')
    expect(copyPathAction).toBeDefined()
    copyPathAction?.onPress()
    expect(sheets.clipboardWriteText).toHaveBeenCalledWith('/wt/README.md')
  })
})
