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

describe('sidebar toggle shortcuts while a plugin guest has focus', () => {
  it.each([false, true])('forwards the left sidebar toggle with browserPage=%s', (browserPage) => {
    const { send, press } = pluginGuestHarness(browserPage)
    const consumed = press(keyDown('b', 'KeyB'))
    expect(send).toHaveBeenCalledWith('ui:toggleLeftSidebar')
    expect(consumed).toHaveBeenCalled()
  })

  it('forwards the right sidebar toggle from a plugin frame', () => {
    const { send, press } = pluginGuestHarness()
    const consumed = press(keyDown('l', 'KeyL'))
    expect(send).toHaveBeenCalledWith('ui:toggleRightSidebar')
    expect(consumed).toHaveBeenCalled()
  })

  it('keeps the browser address-bar chord ahead of the right sidebar toggle', () => {
    const { send, press } = pluginGuestHarness(true)
    const consumed = press(keyDown('l', 'KeyL'))
    expect(send).toHaveBeenCalledWith('ui:focusBrowserAddressBar', {
      browserPageId: 'plugin-frame:7'
    })
    expect(consumed).toHaveBeenCalled()
  })

  it.each([false, true])(
    'consumes held sidebar chord repeats without retoggling (browserPage=%s)',
    (browserPage) => {
      const { send, press } = pluginGuestHarness(browserPage)
      press(keyDown('b', 'KeyB'))
      expect(send).toHaveBeenCalledWith('ui:toggleLeftSidebar')
      send.mockClear()
      const consumed = press({ ...keyDown('b', 'KeyB'), isAutoRepeat: true })
      expect(consumed).toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    }
  )

  it('leaves keys without an Orca chord with the guest', () => {
    const { send, press } = pluginGuestHarness()
    const bare = { ...keyDown('q', 'KeyQ'), meta: false, control: false }
    expect(press(bare)).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves browser-page chords and the editor save chord to the guest', () => {
    const { send, press } = pluginGuestHarness()
    // Mod+R would reload and Mod+F would open browser find; Mod+S rides editor.keydown, so they must not double-fire.
    expect(press(keyDown('r', 'KeyR'))).not.toHaveBeenCalled()
    expect(press(keyDown('s', 'KeyS'))).not.toHaveBeenCalled()
    expect(press(keyDown('f', 'KeyF'))).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
