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
    target: { handle: 'terminal-1' },
    tabs: [],
    isTabChatView: () => false,
    nativeChatTranscriptIsLocalReadable: true,
    onDismiss: vi.fn(),
    onToggleChat: vi.fn(),
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
    const target = { handle: 'terminal-1' }
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
      target: { handle: 'terminal-1' },
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
      target: { handle: 'terminal-2' },
      tabs: [first, second],
      onCloseSessionTab
    })

    actions.find((action) => action.label === 'Close')?.onPress()
    expect(onCloseSessionTab).toHaveBeenCalledWith(second)
  })

  it('switches a Hermes terminal to its overlay on a capable host', () => {
    const onToggleChat = vi.fn()
    const actions = buildActions({
      tabs: [{ type: 'terminal', id: 'tab-h', terminal: 'terminal-1', launchAgent: 'hermes' }],
      hermesOverlaySupported: true,
      onToggleChat
    })
    const action = actions.find((candidate) => candidate.id === 'toggleChatView')
    expect(action?.label).toBe('Switch to chat view')
    action?.onPress()
    expect(onToggleChat).toHaveBeenCalledWith('tab-h')
  })

  it('keeps Hermes in the terminal on an older host', () => {
    const actions = buildActions({
      tabs: [{ type: 'terminal', id: 'tab-h', terminal: 'terminal-1', launchAgent: 'hermes' }]
    })
    expect(actions.find((candidate) => candidate.id === 'toggleChatView')).toBeUndefined()
  })

  it('still offers chat view on a Claude terminal', () => {
    const actions = buildActions({
      tabs: [{ type: 'terminal', id: 'tab-c', terminal: 'terminal-1', launchAgent: 'claude' }],
      structuredAgents: ['hermes', 'claude']
    })
    expect(actions.find((action) => action.id === 'toggleChatView')?.label).toBe(
      'Switch to chat view'
    )
    expect(actions.find((action) => action.id === 'structuredChatUnavailable')).toBeUndefined()
  })

  it('still explains that another structured terminal cannot become a chat', () => {
    const actions = buildActions({
      tabs: [{ type: 'terminal', id: 'tab-g', terminal: 'terminal-1', launchAgent: 'gemini' }],
      structuredAgents: ['gemini']
    })
    expect(actions.find((action) => action.id === 'structuredChatUnavailable')).toMatchObject({
      disabled: true,
      label: "Can't switch this Gemini terminal to Chat"
    })
  })

  it('falls back to the handle close when no session tab owns the handle', () => {
    const onClose = vi.fn()
    const onCloseSessionTab = vi.fn()
    const target = { handle: 'terminal-9' }
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
})
