import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { ActionSheetAction } from '../components/ActionSheetModal'

const sheets = vi.hoisted(() => ({
  labelsByTitle: new Map<string, string[]>(),
  actionsByTitle: new Map<string, ActionSheetAction[]>()
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('lucide-react-native', () => ({
  Copy: 'Icon',
  Eye: 'Icon',
  GitFork: 'Icon',
  CornerDownRight: 'Icon',
  FileText: 'Icon',
  Globe: 'Icon',
  RefreshCw: 'Icon',
  SquareTerminal: 'Icon'
}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({}) }))
vi.mock('../platform/haptics', () => ({ triggerSuccess: () => {}, triggerError: () => {} }))
vi.mock('../components/ActionSheetModal', () => ({
  ActionSheetModal: ({ title, actions }: { title: string; actions: ActionSheetAction[] }) => {
    sheets.actionsByTitle.set(title, actions)
    sheets.labelsByTitle.set(
      title,
      actions.map((action) => action.label)
    )
    return null
  }
}))
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

it('opens side chat permissions from the chat tab sheet while retaining close actions', async () => {
  const handleOpenSideChat = vi.fn(async () => true)
  const source = {
    type: 'agent-session',
    id: 'chat',
    sessionId: 'codex_source',
    agent: 'codex',
    title: 'Source chat',
    isActive: true,
    sideChatSupported: true
  } as const
  const controller = mountFixture<Parameters<typeof MobileSessionSheets>[0]['controller']>({
    worktreeId: 'folder:workspace',
    isFolderWorkspaceRoute: true,
    sessionTabs: [source],
    agentSessionActionTarget: source,
    setAgentSessionActionTarget: vi.fn(),
    nativeChatController: { isTabChatView: () => false },
    createTabAgentActions: [],
    sendDiffNotesAgentActions: [],
    agentSessionHostSupport: { sideChat: true, readOnlySideChat: true },
    handleOpenSideChat,
    closeWithBulkActions: () => [{ label: 'Close chat', onPress: vi.fn() }]
  })
  let mounted: ReturnType<typeof create> | undefined
  await act(async () => {
    mounted = create(createElement(MobileSessionSheets, { controller }))
  })
  const actions = sheets.actionsByTitle.get('Source chat') ?? []
  expect(actions.map((action) => action.label)).toContain('Close chat')
  const open = actions.find((action) => action.label === 'New side chat')
  expect(open).toBeDefined()
  await act(async () => {
    open?.onPress()
  })
  const permissionActions = sheets.actionsByTitle.get('New side chat') ?? []
  expect(permissionActions.find((action) => action.label === 'Read only')?.disabled).toBe(false)
  const inherit = permissionActions.find((action) => action.label === 'Use main chat permissions')
  expect(inherit).toBeDefined()
  await act(async () => {
    inherit?.onPress()
  })
  expect(handleOpenSideChat).toHaveBeenCalledExactlyOnceWith(source, '', [], 'inherit')
  await act(async () => mounted?.unmount())
})
