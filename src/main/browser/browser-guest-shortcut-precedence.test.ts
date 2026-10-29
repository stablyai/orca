import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    BrowserWindow: class {
      webContents = new (class extends EventEmitter {
        send = vi.fn()
        reloadIgnoringCache = (): void => this.send('reloadIgnoringCache')
      })()
    },
    screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) },
    webContents: { fromId: vi.fn() }
  }
})

import { BrowserWindow } from 'electron'
import {
  findKeybindingConflicts,
  isKeybindingInterceptedByMainProcess,
  KEYBINDING_DEFINITIONS,
  type KeybindingOverrides
} from '../../shared/keybindings'
import { setupGuestShortcutForwarding } from './browser-guest-shortcut-forwarding'

const CHORD = 'Mod+Alt+Shift+1'

function rendererMessagesForGuestChord(keybindings: KeybindingOverrides): unknown[][] {
  const guest = new BrowserWindow().webContents
  const renderer = new BrowserWindow().webContents
  const cleanup = setupGuestShortcutForwarding({
    browserTabId: 'tab-1',
    guest,
    resolveRenderer: () => renderer,
    resolveWorkspaceId: () => 'workspace-1',
    shouldForwardDictationShortcut: () => true,
    getKeybindings: () => keybindings
  })
  const isMac = process.platform === 'darwin'
  const event: Electron.Event = { preventDefault: vi.fn(), defaultPrevented: false }
  const input: Electron.Input = {
    type: 'keyDown',
    code: 'Digit1',
    key: '1',
    meta: isMac,
    control: !isMac,
    alt: true,
    shift: true,
    isAutoRepeat: false,
    isComposing: false,
    location: 0,
    modifiers: []
  }
  guest.emit('before-input-event', event, input)
  cleanup()
  return vi.mocked(renderer.send).mock.calls
}

describe('browser guest precedence for main-process shortcuts', () => {
  it('reports a browser binding as conflicting exactly when the guest lets the intercepted action win', () => {
    const guestDispatchedBrowserActions = KEYBINDING_DEFINITIONS.filter(
      (definition) =>
        definition.scope === 'browser' &&
        rendererMessagesForGuestChord({ [definition.id]: [CHORD] }).length > 0
    )
    expect(guestDispatchedBrowserActions.length).toBeGreaterThan(0)

    const mismatches: string[] = []
    for (const browser of guestDispatchedBrowserActions) {
      const alone = rendererMessagesForGuestChord({ [browser.id]: [CHORD] })
      for (const intercepted of KEYBINDING_DEFINITIONS.filter(
        isKeybindingInterceptedByMainProcess
      )) {
        const shared = { [browser.id]: [CHORD], [intercepted.id]: [CHORD] }
        const browserWins =
          JSON.stringify(rendererMessagesForGuestChord(shared)) === JSON.stringify(alone)
        const reported =
          findKeybindingConflicts(process.platform, shared, {
            includeMainProcessInterception: true
          }).length > 0
        if (reported === browserWins) {
          mismatches.push(`${browser.id} vs ${intercepted.id}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })
})
