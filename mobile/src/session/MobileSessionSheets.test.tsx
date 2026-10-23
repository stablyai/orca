import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { MobileSessionTab } from './mobile-session-route-types'

const sheets = vi.hoisted(() => ({
  labelsByTitle: new Map<string, string[]>(),
  actionsByTitle: new Map<string, ActionSheetAction[]>(),
  clipboardText: ''
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('lucide-react-native', () => ({
  Copy: 'Icon',
  FileText: 'Icon',
  Globe: 'Icon',
  RefreshCw: 'Icon',
  SquareTerminal: 'Icon'
}))
vi.mock('expo-clipboard', () => ({
  setStringAsync: async (text: string) => {
    sheets.clipboardText = text
    return true
  }
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

let renderer: ReturnType<typeof create> | null = null

beforeEach(() => {
  sheets.labelsByTitle.clear()
  sheets.actionsByTitle.clear()
  sheets.clipboardText = ''
})
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
})

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
    renderer = create(
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
})

describe('the Markdown tab Copy Path action', () => {
  it.each([
    {
      name: 'workspace root',
      filePath: '/workspace/README.md',
      relativePath: 'README.md',
      expected: '/workspace/README.md'
    },
    {
      name: 'nested file with spaces',
      filePath: '/workspace/docs/Read me.md',
      relativePath: 'docs/Read me.md',
      expected: '/workspace/docs/Read me.md'
    },
    {
      name: 'Windows host',
      filePath: 'C:\\workspace\\docs\\README.md',
      relativePath: 'docs/README.md',
      expected: 'C:\\workspace\\docs\\README.md'
    },
    {
      name: 'UNC host',
      filePath: '\\\\server\\share\\docs\\README.md',
      relativePath: 'docs/README.md',
      expected: '\\\\server\\share\\docs\\README.md'
    },
    {
      name: 'legacy missing absolute path',
      filePath: '',
      relativePath: 'docs/README.md',
      expected: 'docs/README.md'
    },
    {
      name: 'missing relative path',
      filePath: '/workspace/docs/README.md',
      relativePath: '',
      expected: '/workspace/docs/README.md'
    }
  ])('copies the host path for $name', async ({ filePath, relativePath, expected }) => {
    const setMarkdownActionTarget = vi.fn()
    const showToast = vi.fn()
    const target: Extract<MobileSessionTab, { type: 'markdown' }> = {
      type: 'markdown',
      id: 'md-1',
      title: 'README.md',
      filePath,
      relativePath,
      isDirty: false,
      isActive: true,
      documentVersion: 'version-1'
    }
    const controller = mountFixture<Parameters<typeof MobileSessionSheets>[0]['controller']>({
      worktreeId: 'folder:/workspace',
      isFolderWorkspaceRoute: true,
      isFloatingWorkspaceRoute: false,
      sessionTabs: [target],
      nativeChatController: { isTabChatView: () => false },
      createTabAgentActions: [],
      sendDiffNotesAgentActions: [],
      closeWithBulkActions: () => [],
      markdownActionTarget: target,
      setMarkdownActionTarget,
      showToast
    })
    await act(async () => {
      renderer = create(createElement(MobileSessionSheets, { controller }))
    })
    const action = sheets.actionsByTitle
      .get('README.md')
      ?.find((entry) => entry.label === 'Copy Path')
    if (!action) {
      throw new Error('Markdown Copy Path action is missing')
    }
    await act(async () => action.onPress())
    expect(sheets.clipboardText).toBe(expected)
    expect(setMarkdownActionTarget).toHaveBeenCalledExactlyOnceWith(null)
    expect(showToast).toHaveBeenCalledExactlyOnceWith('Path copied')
  })
})
