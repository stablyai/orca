import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMainWindowShortcutRouting } from './main-window-shortcut-routing'

vi.mock('electron', () => ({ app: { isPackaged: true } }))

afterEach(() => vi.restoreAllMocks())

describe('native paste shortcut routing', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'leaves %s paste chords to native delivery in text fields and terminals',
    (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      for (const terminalFocused of [false, true]) {
        const webContents = Object.assign(new EventEmitter(), { send: vi.fn() })
        const window = Object.assign(new EventEmitter(), { webContents })
        installMainWindowShortcutRouting({
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing only registers events and sends messages on this window.
          mainWindow: window as unknown as BrowserWindow,
          store: null,
          focus: {
            dispose: () => {},
            isFloatingPanelFocused: () => false,
            isFloatingTerminalInputFocused: () => false,
            isMarkdownEditorFocused: () => false,
            isRendererProcessGone: () => false,
            isShortcutRecorderFocused: () => false,
            isTerminalInputFocused: () => terminalFocused,
            notifySystemResume: () => {}
          }
        })
        for (const [key, code] of [
          ['v', 'KeyV'],
          ['м', 'KeyV'],
          ['v', 'Period']
        ]) {
          const event = { preventDefault: vi.fn() }
          webContents.emit('before-input-event', event, {
            type: 'keyDown',
            key,
            code,
            meta: platform === 'darwin',
            control: platform !== 'darwin',
            alt: false,
            shift: false,
            isAutoRepeat: false
          })
          expect(event.preventDefault).not.toHaveBeenCalled()
        }
        expect(webContents.send).not.toHaveBeenCalled()
      }
    }
  )
})
