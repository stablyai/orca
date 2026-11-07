import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { ActionSheetAction } from '../components/ActionSheetModal'

const captured = vi.hoisted(() => ({
  actionsByTitle: new Map<string, ActionSheetAction[]>(),
  clipboardWriteText: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  ChevronRight: 'Icon',
  Copy: 'Icon',
  FileText: 'Icon',
  Globe: 'Icon',
  RefreshCw: 'Icon',
  SquareTerminal: 'Icon'
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: captured.clipboardWriteText })
}))
vi.mock('../platform/haptics', () => ({ triggerSuccess: () => {}, triggerError: () => {} }))
vi.mock('../components/ActionSheetModal', () => ({
  ActionSheetModal: ({ title, actions }: { title: string; actions: ActionSheetAction[] }) => {
    captured.actionsByTitle.set(title, actions)
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
vi.mock('./mobile-terminal-action-sheet-actions', () => ({
  getMobileTerminalActionSheetActions: () => []
}))

import { MobileBrowserTabActionSheet } from './MobileBrowserTabActionSheet'
import { MobileSessionSheets } from './MobileSessionSheets'

describe('file and browser tab action sheets', () => {
  it('copies relativePath from the File tab action sheet Copy Path action when non-empty', async () => {
    captured.actionsByTitle.clear()
    captured.clipboardWriteText.mockClear()
    const setFileActionTarget = vi.fn()
    const showToast = vi.fn()
    const controller = mountFixture<Parameters<typeof MobileSessionSheets>[0]['controller']>({
      worktreeId: 'repo::/wt',
      isFolderWorkspaceRoute: false,
      isFloatingWorkspaceRoute: false,
      sessionTabs: [],
      nativeChatController: { isTabChatView: () => false },
      createTabAgentActions: [],
      sendDiffNotesAgentActions: [],
      closeWithBulkActions: () => [],
      fileActionTarget: {
        type: 'file',
        id: 'file-1',
        title: 'index.ts',
        filePath: 'D:/code/orca/src/index.ts',
        relativePath: 'src/index.ts',
        isDirty: false,
        isActive: true
      },
      setFileActionTarget,
      showToast
    })

    await act(async () => {
      create(createElement(MobileSessionSheets, { controller }))
    })

    const copyPathAction = captured.actionsByTitle
      .get('index.ts')
      ?.find((action) => action.label === 'Copy Path')
    expect(copyPathAction).toBeDefined()
    copyPathAction?.onPress()
    await Promise.resolve()

    expect(setFileActionTarget).toHaveBeenCalledWith(null)
    expect(captured.clipboardWriteText).toHaveBeenCalledWith('src/index.ts')
    expect(showToast).toHaveBeenCalledWith('Path copied')
  })

  it('omits Copy Path from the File tab action sheet when relativePath is empty', async () => {
    captured.actionsByTitle.clear()
    const controller = mountFixture<Parameters<typeof MobileSessionSheets>[0]['controller']>({
      worktreeId: 'repo::/wt',
      isFolderWorkspaceRoute: false,
      isFloatingWorkspaceRoute: false,
      sessionTabs: [],
      nativeChatController: { isTabChatView: () => false },
      createTabAgentActions: [],
      sendDiffNotesAgentActions: [],
      closeWithBulkActions: () => [],
      fileActionTarget: {
        type: 'file',
        id: 'file-2',
        title: 'untitled.ts',
        filePath: 'D:/code/orca/src/untitled.ts',
        relativePath: '',
        isDirty: false,
        isActive: true
      },
      setFileActionTarget: vi.fn(),
      showToast: vi.fn()
    })

    await act(async () => {
      create(createElement(MobileSessionSheets, { controller }))
    })

    const labels = captured.actionsByTitle.get('untitled.ts')?.map((action) => action.label) ?? []
    expect(labels).not.toContain('Copy Path')
  })

  it('offers Copy URL for a browser tab and copies tab.url', async () => {
    captured.actionsByTitle.clear()
    captured.clipboardWriteText.mockClear()
    const onClose = vi.fn()
    const onToast = vi.fn()

    await act(async () => {
      create(
        createElement(MobileBrowserTabActionSheet, {
          target: {
            type: 'browser',
            id: 'browser-1',
            title: 'Docs',
            browserWorkspaceId: 'bw-1',
            browserPageId: 'page-1',
            url: 'https://docs.stably.ai/guide',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          },
          onClose,
          onNavigate: vi.fn(),
          onCloseTab: vi.fn(),
          onToast
        })
      )
    })

    const copyUrlAction = captured.actionsByTitle
      .get('Docs')
      ?.find((action) => action.label === 'Copy URL')
    expect(copyUrlAction).toBeDefined()
    copyUrlAction?.onPress()
    await Promise.resolve()

    expect(onClose).toHaveBeenCalledOnce()
    expect(captured.clipboardWriteText).toHaveBeenCalledWith('https://docs.stably.ai/guide')
    expect(onToast).toHaveBeenCalledWith('URL copied')
  })

  it('keeps Copy URL and copies tab.url as-is for a file: browser tab, and omits Copy URL when url is empty', async () => {
    captured.actionsByTitle.clear()
    captured.clipboardWriteText.mockClear()
    const onClose = vi.fn()
    const onToast = vi.fn()

    await act(async () => {
      create(
        createElement(MobileBrowserTabActionSheet, {
          target: {
            type: 'browser',
            id: 'browser-2',
            title: 'report.html',
            browserWorkspaceId: 'bw-1',
            browserPageId: 'page-2',
            url: 'file:///D:/code/orca/report.html',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          },
          onClose,
          onNavigate: vi.fn(),
          onCloseTab: vi.fn(),
          onToast
        })
      )
    })

    const fileUrlActions = captured.actionsByTitle.get('report.html') ?? []
    expect(fileUrlActions.map((action) => action.label)).not.toContain('Copy Path')
    const copyUrlAction = fileUrlActions.find((action) => action.label === 'Copy URL')
    expect(copyUrlAction).toBeDefined()
    copyUrlAction?.onPress()
    await Promise.resolve()

    expect(onClose).toHaveBeenCalledOnce()
    expect(captured.clipboardWriteText).toHaveBeenCalledWith('file:///D:/code/orca/report.html')
    expect(onToast).toHaveBeenCalledWith('URL copied')

    captured.actionsByTitle.clear()
    await act(async () => {
      create(
        createElement(MobileBrowserTabActionSheet, {
          target: {
            type: 'browser',
            id: 'browser-3',
            title: 'Blank',
            browserWorkspaceId: 'bw-1',
            browserPageId: 'page-3',
            url: '',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          },
          onClose,
          onNavigate: vi.fn(),
          onCloseTab: vi.fn(),
          onToast
        })
      )
    })

    expect(captured.actionsByTitle.get('Blank')?.map((action) => action.label)).not.toContain(
      'Copy URL'
    )
  })
})
