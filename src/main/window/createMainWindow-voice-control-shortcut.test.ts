import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

import { installMainWindowShortcutRouting } from './main-window/main-window-shortcut-routing'

type BeforeInputEvent = { preventDefault: () => void }
type BeforeInput = {
  type: string
  code: string
  key: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
  isAutoRepeat?: boolean
}

describe('main window voice control shortcut', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('intercepts the voice control chord only with the gate on, and only where voice.control is bound (macOS by default)', () => {
    const windowHandlers: Record<string, (event: BeforeInputEvent, input: BeforeInput) => void> = {}
    const webContents = {
      on: vi.fn((event: string, handler: (event: BeforeInputEvent, input: BeforeInput) => void) => {
        windowHandlers[event] = handler
      }),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const focus = {
      isFloatingPanelFocused: () => false,
      isFloatingTerminalInputFocused: () => false,
      isMarkdownEditorFocused: () => false,
      isShortcutRecorderFocused: () => false,
      isTerminalInputFocused: () => false
    }
    const voice: { enabled: boolean; sttModel: string; control: { enabled: boolean } } = {
      enabled: true,
      sttModel: 'test-model',
      control: { enabled: false }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial deps mock; the shortcut path reads only getSettings().voice.control.enabled and never touches UI state.
    installMainWindowShortcutRouting({
      focus,
      mainWindow: { webContents, on: vi.fn() },
      store: { getSettings: () => ({ voice }) }
    } as never)

    const isDarwin = process.platform === 'darwin'
    const controlInput: BeforeInput = {
      type: 'keyDown',
      code: 'KeyV',
      key: 'v',
      meta: isDarwin,
      control: !isDarwin,
      alt: false,
      shift: true
    }

    const beforeInput = windowHandlers['before-input-event']
    expect(beforeInput).toBeDefined()

    const disabledPreventDefault = vi.fn()
    beforeInput({ preventDefault: disabledPreventDefault }, controlInput)
    expect(disabledPreventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:voiceControlToggle')

    voice.control.enabled = true
    const enabledPreventDefault = vi.fn()
    beforeInput({ preventDefault: enabledPreventDefault }, controlInput)
    if (isDarwin) {
      expect(enabledPreventDefault).toHaveBeenCalledTimes(1)
      expect(webContents.send).toHaveBeenCalledWith('ui:voiceControlToggle')

      webContents.send.mockClear()
      const repeatPreventDefault = vi.fn()
      beforeInput({ preventDefault: repeatPreventDefault }, { ...controlInput, isAutoRepeat: true })
      expect(repeatPreventDefault).toHaveBeenCalledTimes(1)
      expect(webContents.send).not.toHaveBeenCalled()
    } else {
      // The default binding is darwin-only — off macOS Ctrl+Shift+V is terminal paste
      // (pinned cross-platform in window-shortcut-policy-voice-control.test.ts), so even
      // with the gate on the chord passes through unintercepted.
      expect(enabledPreventDefault).not.toHaveBeenCalled()
      expect(webContents.send).not.toHaveBeenCalledWith('ui:voiceControlToggle')
    }
  })
})
