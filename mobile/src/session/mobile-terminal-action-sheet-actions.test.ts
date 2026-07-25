import { describe, expect, it, vi } from 'vitest'
import { getMobileTerminalActionSheetActions } from './mobile-terminal-action-sheet-actions'

vi.mock('lucide-react-native', () => ({
  Eraser: vi.fn(),
  MessageSquare: vi.fn(),
  Monitor: vi.fn(),
  Smartphone: vi.fn(),
  SquareTerminal: vi.fn()
}))

describe('getMobileTerminalActionSheetActions', () => {
  it('defers Rename until after the action sheet closes', () => {
    const target = { handle: 'terminal-1' }
    const onDismiss = vi.fn()
    const onRename = vi.fn()
    const actions = getMobileTerminalActionSheetActions({
      target,
      tabs: [],
      isTabChatView: () => false,
      nativeChatTranscriptIsLocalReadable: true,
      onDismiss,
      onToggleChat: vi.fn(),
      isPhoneMode: () => false,
      onToggleDisplayMode: vi.fn(),
      onRename,
      onClear: vi.fn(),
      onClose: vi.fn()
    })

    const rename = actions.find((action) => action.label === 'Rename')
    expect(rename).toMatchObject({ closeBeforePress: true })

    rename?.onPress()
    expect(onRename).toHaveBeenCalledWith(target)
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
