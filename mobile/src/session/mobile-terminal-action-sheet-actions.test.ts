import { describe, expect, it, vi } from 'vitest'
import { getMobileTerminalActionSheetActions } from './mobile-terminal-action-sheet-actions'

vi.mock('lucide-react-native', () => ({
  Eraser: vi.fn(),
  MessageSquare: vi.fn(),
  Monitor: vi.fn(),
  Smartphone: vi.fn(),
  SquareTerminal: vi.fn()
}))

type SheetArgs = Parameters<typeof getMobileTerminalActionSheetActions>[0]

function buildActions(overrides: Partial<SheetArgs> = {}) {
  return getMobileTerminalActionSheetActions({
    target: { tabId: 'tab-x', handle: 'terminal-1' },
    tabs: [],
    tabLeafView: () => 'terminal',
    nativeChatTranscriptIsLocalReadable: true,
    onDismiss: vi.fn(),
    onSetChatView: vi.fn(),
    isPhoneMode: () => false,
    onToggleDisplayMode: vi.fn(),
    onRename: vi.fn(),
    onClear: vi.fn(),
    onClose: vi.fn(),
    onCloseSessionTab: vi.fn(),
    ...overrides
  })
}

const terminalTab = (id: string, handle: string | null) => ({
  type: 'terminal',
  id,
  terminal: handle
})

describe('getMobileTerminalActionSheetActions', () => {
  it('defers Rename until after the action sheet closes', () => {
    const target = { tabId: 'tab-x', handle: 'terminal-1' }
    const onDismiss = vi.fn()
    const onRename = vi.fn()
    const actions = buildActions({ target, onDismiss, onRename })

    const rename = actions.find((action) => action.label === 'Rename')
    expect(rename).toMatchObject({ closeBeforePress: true })

    rename?.onPress()
    expect(onRename).toHaveBeenCalledWith(target)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  // Why: handle-only close lets the pending-terminal effect resurrect the tab (#6927, #7345).
  it('closes the handle through its session tab, not the handle-only path', () => {
    const onClose = vi.fn()
    const onCloseSessionTab = vi.fn()
    const tab = terminalTab('tab-1::leaf-1', 'terminal-1')
    const actions = buildActions({
      target: { tabId: 'tab-1::leaf-1', handle: 'terminal-1' },
      tabs: [tab],
      onClose,
      onCloseSessionTab
    })

    actions.find((action) => action.label === 'Close')?.onPress()
    expect(onCloseSessionTab).toHaveBeenCalledWith(tab)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes the split leaf that owns the handle, not its sibling', () => {
    const onCloseSessionTab = vi.fn()
    const first = terminalTab('tab-1::leaf-1', 'terminal-1')
    const second = terminalTab('tab-1::leaf-2', 'terminal-2')
    const actions = buildActions({
      target: { tabId: 'tab-1::leaf-2', handle: 'terminal-2' },
      tabs: [first, second],
      onCloseSessionTab
    })

    actions.find((action) => action.label === 'Close')?.onPress()
    expect(onCloseSessionTab).toHaveBeenCalledWith(second)
  })

  it('falls back to the handle close when no session tab owns the handle', () => {
    const onClose = vi.fn()
    const onCloseSessionTab = vi.fn()
    const target = { tabId: 'tab-gone', handle: 'terminal-9' }
    const actions = buildActions({
      target,
      tabs: [terminalTab('tab-1::leaf-1', 'terminal-1'), terminalTab('tab-2::leaf-1', null)],
      onClose,
      onCloseSessionTab
    })

    actions.find((action) => action.label === 'Close')?.onPress()
    expect(onClose).toHaveBeenCalledWith(target)
    expect(onCloseSessionTab).not.toHaveBeenCalled()
  })

  it('reaches the view switch and Close on a chat row that has no terminal handle yet (A1c-7)', () => {
    const onSetChatView = vi.fn()
    const onCloseSessionTab = vi.fn()
    const row = terminalTab('P::L', null)
    const actions = buildActions({
      target: { tabId: 'P::L', handle: null },
      tabs: [row],
      tabLeafView: () => 'chat',
      onSetChatView,
      onCloseSessionTab
    })

    expect(actions.map((action) => action.label)).toEqual(['Switch to terminal view', 'Close'])
    actions[0]?.onPress()
    // The item sends the view it names, not a toggle worked out when it runs.
    expect(onSetChatView).toHaveBeenCalledWith('P::L', 'terminal')
    actions[1]?.onPress()
    expect(onCloseSessionTab).toHaveBeenCalledWith(row)
  })

  it('offers chat only for an agent it can name, but always offers the way back from chat', () => {
    const plain = terminalTab('P::A', 'terminal-1')
    const labels = (leafView: 'chat' | 'terminal') =>
      buildActions({
        target: { tabId: 'P::A', handle: 'terminal-1' },
        tabs: [plain],
        tabLeafView: () => leafView
      })[0]?.label
    expect(labels('terminal')).toBe('Switch to Phone')
    expect(labels('chat')).toBe('Switch to terminal view')
  })

  it('sends chat from "Switch to chat view" (R2-F3)', () => {
    const onSetChatView = vi.fn()
    const actions = buildActions({
      target: { tabId: 'P::A', handle: 'terminal-1' },
      tabs: [{ ...terminalTab('P::A', 'terminal-1'), launchAgent: 'claude' }],
      tabLeafView: () => 'terminal',
      onSetChatView
    })
    expect(actions[0]?.label).toBe('Switch to chat view')
    actions[0]?.onPress()
    expect(onSetChatView).toHaveBeenCalledWith('P::A', 'chat')
  })
})
