import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const emitted: { session: unknown; event: string }[] = []
  return { emitted, profileIds: new WeakMap<object, string>() }
})

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  let nextId = 1
  class FakeBrowserWindow extends Emitter {
    id = nextId++
    webContents = Object.assign(new Emitter(), {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned Electron fixture supplies the session identity and lifecycle methods this path uses.
      session: undefined as unknown,
      isDestroyed: () => false,
      setWindowOpenHandler: () => {},
      getURL: () => ''
    })
    constructor(options?: { webPreferences?: { session?: unknown } }) {
      super()
      this.webContents.session = options?.webPreferences?.session
    }
    loadURL = vi.fn(async () => {})
    isDestroyed = () => false
    isFocused = () => false
    isMinimized = () => false
    isFullScreen = () => false
    isMaximized = () => false
    isAlwaysOnTop = () => false
    getBounds = () => ({ x: 0, y: 0, width: 1, height: 1 })
    close = () => {
      this.webContents.emit('destroyed')
      this.emit('closed')
    }
  }
  return { BrowserWindow: FakeBrowserWindow }
})
vi.mock('../../../window/activation/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => true,
  showWindowWithoutStealingFocus: () => {}
}))
vi.mock('../api-runtime/browser-extension-api-host', () => ({
  emitBrowserExtensionEvent: (target: { session?: unknown }, _ns: string, event: string) =>
    mocks.emitted.push({ session: target.session, event })
}))
vi.mock('../browser-extension-support', () => ({ isBrowserExtensionSupportEnabled: () => true }))
vi.mock('../../sessions/profiles/browser-session-profile-identity', () => ({
  getBrowserSessionProfileIdentity: (session: Electron.Session) => mocks.profileIds.get(session)
}))
vi.mock('../../guest-lifecycle/browser-main-window-readiness', () => ({
  watchBrowserMainWindowReadiness: () => {}
}))

const { BrowserWindow } = await import('electron')
const model = await import('./browser-extension-window-model')
const demand = await import('../profile-sessions/browser-extension-profile-demand')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model compares sessions by identity only.
const profileA = { name: 'a' } as unknown as Electron.Session
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
const profileB = { name: 'b' } as unknown as Electron.Session

const focus = (window: Electron.BrowserWindow): boolean => window.emit('focus')

describe("a profile's extension windows", () => {
  it('retains execution for a windows.create page after its originating final tab closes', async () => {
    const { EventEmitter } = await import('node:events')
    const activate = vi.fn(async () => {})
    const suspend = vi.fn(async () => {})
    mocks.profileIds.set(profileA, 'owned-popout')
    demand.attachBrowserExtensionProfileDemand('owned-popout', activate, suspend, () => [
      'extension'
    ])
    const source = Object.assign(new EventEmitter(), {
      session: profileA,
      isDestroyed: () => false
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned Electron fixture supplies the session identity and lifecycle methods this path uses.
    await demand.retainBrowserExtensionPage(source as unknown as Electron.WebContents)
    const popout = model.createBrowserExtensionPopout(profileA, {
      url: 'https://retained.test/',
      type: 'popup',
      presentation: 'unfocused'
    })
    try {
      source.emit('destroyed')
      expect(suspend).not.toHaveBeenCalled()
      expect(activate).toHaveBeenCalledOnce()
      await Promise.resolve()
      expect(popout.loadURL).toHaveBeenCalledWith('https://retained.test/')
    } finally {
      popout.close()
      demand.detachBrowserExtensionProfileDemand('owned-popout')
      mocks.profileIds.delete(profileA)
      mocks.emitted.splice(0)
    }
    expect(suspend).toHaveBeenCalledOnce()
  })

  it("never include another profile's popout, in lookups or events", () => {
    const main = new BrowserWindow()
    model.trackBrowserExtensionMainWindow(main)
    const popout = model.createBrowserExtensionPopout(profileB, {
      url: 'https://b.test/',
      type: 'popup',
      presentation: 'unfocused'
    })
    const ids = (sess: Electron.Session) =>
      model.listBrowserExtensionWindows(sess).map((entry) => entry.window.id)
    expect(ids(profileA)).toEqual([main.id])
    expect(ids(profileB)).toEqual([main.id, popout.id])
    expect(model.getBrowserExtensionWindow(popout.id, profileA)).toBeNull()
    expect(model.getBrowserExtensionWindow(popout.id, profileB)?.window).toBe(popout)

    focus(popout)
    expect(model.getLastFocusedBrowserExtensionWindowId(profileA)).toBe(main.id)
    expect(model.getLastFocusedBrowserExtensionWindowId(profileB)).toBe(popout.id)

    popout.close()
    expect(mocks.emitted).toEqual([
      { session: profileB, event: 'onCreated' },
      { session: profileB, event: 'onFocusChanged' },
      { session: profileB, event: 'onRemoved' }
    ])
  })

  it("keep each profile's last-focused popout when another profile's popout takes focus", () => {
    const main = new BrowserWindow()
    model.trackBrowserExtensionMainWindow(main)
    const options = {
      url: 'https://x.test/',
      type: 'popup' as const,
      presentation: 'unfocused' as const
    }
    const popoutA = model.createBrowserExtensionPopout(profileA, options)
    const popoutB = model.createBrowserExtensionPopout(profileB, options)
    focus(popoutA)
    focus(popoutB)
    expect(model.getLastFocusedBrowserExtensionWindowId(profileA)).toBe(popoutA.id)
    expect(model.getLastFocusedBrowserExtensionWindowId(profileB)).toBe(popoutB.id)
    focus(main)
    expect(model.getLastFocusedBrowserExtensionWindowId(profileA)).toBe(main.id)
    expect(model.getLastFocusedBrowserExtensionWindowId(profileB)).toBe(main.id)
  })
})
