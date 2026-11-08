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

function pluginGuestHarness(browserPage = false) {
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
    browserPage
  })
  const press = (input: Electron.Input) => {
    const preventDefault = vi.fn()
    handlers.get('before-input-event')?.({ preventDefault }, input)
    return preventDefault
  }
  return { send, press }
}

describe('Orca shortcuts while a plugin guest has focus', () => {
  it.each([false, true])('forwards collapse-all with browserPage=%s', (browserPage) => {
    const { send, press } = pluginGuestHarness(browserPage)
    const consumed = press({
      ...keyDown(
        process.platform === 'darwin' ? 'з' : 'р',
        process.platform === 'darwin' ? 'KeyP' : 'KeyH'
      ),
      alt: process.platform === 'darwin',
      shift: process.platform !== 'darwin'
    })
    expect(send).toHaveBeenCalledWith('ui:toggleProjectsCollapse')
    expect(consumed).toHaveBeenCalled()
  })

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
    // Mod+F would open browser find; Mod+S rides editor.keydown, so it must not double-fire.
    expect(press(keyDown('s', 'KeyS'))).not.toHaveBeenCalled()
    expect(press(keyDown('f', 'KeyF'))).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  // #37472: these resolved to Orca actions but the plugin frame kept the keys.
  it('toggles the sidebars instead of the browser address bar', () => {
    const { send, press } = pluginGuestHarness()
    expect(press(keyDown('b', 'KeyB'))).toHaveBeenCalled()
    expect(press(keyDown('l', 'KeyL'))).toHaveBeenCalled()
    expect(send.mock.calls).toEqual([['ui:toggleLeftSidebar'], ['ui:toggleRightSidebar']])
  })

  it('sends zoom chords to Orca rather than dropping them', () => {
    const { send, press } = pluginGuestHarness()
    expect(press(keyDown('=', 'Equal'))).toHaveBeenCalled()
    expect(press(keyDown('-', 'Minus'))).toHaveBeenCalled()
    expect(press(keyDown('0', 'Digit0'))).toHaveBeenCalled()
    expect(send.mock.calls).toEqual([
      ['terminal:zoom', 'in'],
      ['terminal:zoom', 'out'],
      ['terminal:zoom', 'reset']
    ])
  })
})
