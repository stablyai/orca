import type { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const emitted: { session: unknown; event: string }[] = []
  return { emitted }
})

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  let nextId = 1
  class FakeBrowserWindow extends Emitter {
    id = nextId++
    webContents = Object.assign(new Emitter(), {
      setWindowOpenHandler: () => {},
      getURL: () => ''
    })
    loadURL = async () => {}
    isDestroyed = () => false
    isFocused = () => false
    isMinimized = () => false
    isFullScreen = () => false
    isMaximized = () => false
    isAlwaysOnTop = () => false
    getBounds = () => ({ x: 0, y: 0, width: 1, height: 1 })
    close = () => this.emit('closed')
  }
  return { BrowserWindow: FakeBrowserWindow }
})
vi.mock('../../window/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => true,
  showWindowWithoutStealingFocus: () => {}
}))
vi.mock('./browser-extension-api-host', () => ({
  emitBrowserExtensionEvent: (target: { session?: unknown }, _ns: string, event: string) =>
    mocks.emitted.push({ session: target.session, event })
}))
vi.mock('./browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => true }))
vi.mock('./browser-extension-main-window-readiness', () => ({
  watchBrowserExtensionMainWindowReadiness: () => {}
}))

const { BrowserWindow } = await import('electron')
const model = await import('./browser-extension-window-model')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model compares sessions by identity only.
const profileA = { name: 'a' } as unknown as Electron.Session
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
const profileB = { name: 'b' } as unknown as Electron.Session

describe("a profile's extension windows", () => {
  it("never include another profile's popout, in lookups or events", () => {
    const main = new BrowserWindow()
    model.trackBrowserExtensionMainWindow(main)
    const popout = model.createBrowserExtensionPopout(profileB, {
      url: 'https://b.test/',
      type: 'popup',
      focused: false
    })
    const ids = (sess: Electron.Session) =>
      model.listBrowserExtensionWindows(sess).map((entry) => entry.window.id)
    expect(ids(profileA)).toEqual([main.id])
    expect(ids(profileB)).toEqual([main.id, popout.id])
    expect(model.getBrowserExtensionWindow(popout.id, profileA)).toBeNull()
    expect(model.getBrowserExtensionWindow(popout.id, profileB)?.window).toBe(popout)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake window is an EventEmitter.
    ;(popout as unknown as EventEmitter).emit('focus')
    expect(model.getLastFocusedBrowserExtensionWindowId(profileA)).toBe(main.id)
    expect(model.getLastFocusedBrowserExtensionWindowId(profileB)).toBe(popout.id)

    popout.close()
    expect(mocks.emitted).toEqual([
      { session: profileB, event: 'onCreated' },
      { session: profileB, event: 'onFocusChanged' },
      { session: profileB, event: 'onRemoved' }
    ])
  })
})
