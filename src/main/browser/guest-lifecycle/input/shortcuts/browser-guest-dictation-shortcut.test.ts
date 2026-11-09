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
  it('hands the chord to Orca so dictation can target the page', () => {
    const { prevented, renderer } = pressDictationInPage(false)

    expect(prevented).toBe(true)
    expect(renderer.send).toHaveBeenCalledWith('ui:dictationKeyDown')
  })

  it('leaves the chord to the page while an IME composition owns it', () => {
    const { prevented, renderer } = pressDictationInPage(true)

    expect(prevented).toBe(false)
    expect(renderer.send).not.toHaveBeenCalledWith('ui:dictationKeyDown')
  })
})
