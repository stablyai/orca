import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: vi.fn() }
}))

import { setupGuestShortcutForwarding } from './browser-guest-shortcut-forwarding'

type Handler = (event: { preventDefault: () => void }, input: Electron.Input) => void

const mod = process.platform === 'darwin' ? { meta: true } : { control: true }

function keyDown(key: string, code: string): Electron.Input {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarding reads only these key fields.
  return {
    type: 'keyDown',
    key,
    code,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    isAutoRepeat: false,
    ...mod
  } as Electron.Input
}

function pluginGuestHarness() {
  const send = vi.fn()
  const handlers = new Map<string, Handler>()
  const guest = {
    id: 7,
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    off: vi.fn()
  }
  setupGuestShortcutForwarding({
    browserTabId: 'plugin-frame:7',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarding only subscribes to guest input events.
    guest: guest as unknown as Electron.WebContents,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarding only sends to the renderer.
    resolveRenderer: () => ({ send }) as unknown as Electron.WebContents,
    // Orca's settings chord is the person's own binding here; the menu owns the default.
    getKeybindings: () => ({ 'app.settings': ['Mod+Comma'] }),
    browserPage: false
  })
  const press = (input: Electron.Input) => {
    const preventDefault = vi.fn()
    handlers.get('before-input-event')?.({ preventDefault }, input)
    return preventDefault
  }
  return { send, press }
}

describe('Orca shortcuts while a plugin guest has focus', () => {
  it('forwards app shortcuts to Orca and keeps them from the guest', () => {
    const { send, press } = pluginGuestHarness()
    const consumed = press(keyDown(',', 'Comma'))
    expect(send).toHaveBeenCalledWith('ui:openSettings')
    expect(consumed).toHaveBeenCalled()
  })

  it('closes the active tab, not a browser source', () => {
    const { send, press } = pluginGuestHarness()
    press(keyDown('w', 'KeyW'))
    expect(send).toHaveBeenCalledWith('ui:closeActiveTab')
  })

  it('leaves browser-page chords and the editor save chord to the guest', () => {
    const { send, press } = pluginGuestHarness()
    // Mod+L would focus a browser address bar; Mod+S rides editor.keydown, so it must not double-fire.
    expect(press(keyDown('l', 'KeyL'))).not.toHaveBeenCalled()
    expect(press(keyDown('s', 'KeyS'))).not.toHaveBeenCalled()
    expect(press(keyDown('f', 'KeyF'))).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
