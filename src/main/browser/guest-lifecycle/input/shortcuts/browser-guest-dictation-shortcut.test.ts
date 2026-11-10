import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    BrowserWindow: class {
      webContents = new (class extends EventEmitter {
        send = vi.fn()
      })()
    },
    screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) },
    webContents: { fromId: vi.fn() }
  }
})

import { BrowserWindow } from 'electron'
import { setupGuestShortcutForwarding } from './browser-guest-shortcut-forwarding'

function pressDictationInPage(isComposing: boolean) {
  const guest = new BrowserWindow().webContents
  const renderer = new BrowserWindow().webContents
  const cleanup = setupGuestShortcutForwarding({
    browserTabId: 'tab-1',
    guest,
    resolveRenderer: () => renderer,
    shouldForwardDictationShortcut: () => true,
    getKeybindings: () => ({})
  })
  const isMac = process.platform === 'darwin'
  const event: Electron.Event = { preventDefault: vi.fn(), defaultPrevented: false }
  const input: Electron.Input = {
    type: 'keyDown',
    code: 'KeyE',
    key: 'e',
    meta: isMac,
    control: !isMac,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    isComposing,
    location: 0,
    modifiers: []
  }
  guest.emit('before-input-event', event, input)
  cleanup()
  return { prevented: vi.mocked(event.preventDefault).mock.calls.length > 0, renderer }
}

describe('dictation shortcut from a focused browser page', () => {
  it('leaves the chord to the page while an IME composition owns it', () => {
    const composing = pressDictationInPage(true)
    expect(composing.prevented).toBe(false)
    expect(composing.renderer.send).not.toHaveBeenCalledWith('ui:dictationKeyDown')

    const typed = pressDictationInPage(false)
    expect(typed.prevented).toBe(true)
    expect(typed.renderer.send).toHaveBeenCalledWith('ui:dictationKeyDown')
  })
})
