import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NotchWindowModule from './notch-window'

// Why this file exists: the notch is an always-on-top window that never closes on its own.
// Electron emits `window-all-closed` only once the LAST window is gone, and Orca uses that
// event to complete a Cmd+Q its renderer deferred. A notch window still alive at that moment
// strands the app: no event, no re-triggered quit, no exit — and the bar stays on screen with
// no owner. These tests pin the teardown ordering that keeps quit working.

type FakeWindow = {
  id: number
  visible: boolean
  destroyed: boolean
  hide: () => void
  destroy: () => void
  isVisible: () => boolean
  isDestroyed: () => boolean
  once: () => void
  on: () => void
  setAlwaysOnTop: () => void
  setVisibleOnAllWorkspaces: (...args: unknown[]) => void
  setIgnoreMouseEvents: () => void
  setBounds: () => void
  showInactive: () => void
  loadURL: () => void
  loadFile: () => void
  webContents: { isDestroyed: () => boolean; send: () => void; once: () => void; session: unknown }
}

const appHandlers = new Map<string, () => void>()
const workspaceCalls: unknown[][] = []
let created: FakeWindow[] = []
const order: string[] = []

function makeWindow(id: number): FakeWindow {
  const win: FakeWindow = {
    id,
    visible: true,
    destroyed: false,
    hide: () => {
      order.push(`hide:${id}`)
      win.visible = false
    },
    destroy: () => {
      order.push(`destroy:${id}`)
      win.destroyed = true
    },
    isVisible: () => win.visible,
    isDestroyed: () => win.destroyed,
    once: () => undefined,
    on: () => undefined,
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: (...args: unknown[]) => {
      workspaceCalls.push(args)
    },
    setIgnoreMouseEvents: () => undefined,
    setBounds: () => undefined,
    showInactive: () => undefined,
    loadURL: () => undefined,
    loadFile: () => undefined,
    webContents: {
      isDestroyed: () => false,
      send: () => undefined,
      once: () => undefined,
      session: {
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined
      }
    }
  }
  created.push(win)
  return win
}

vi.mock('electron', () => ({
  app: {
    on: (event: string, handler: () => void) => {
      appHandlers.set(event, handler)
    },
    isPackaged: false,
    getAppPath: () => '/repo'
  },
  BrowserWindow: class {
    constructor() {
      return makeWindow(created.length + 1) as unknown as object
    }
  },
  screen: {
    getPrimaryDisplay: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1728, height: 1117 },
      workArea: { x: 0, y: 33, width: 1728, height: 1084 }
    }),
    on: () => undefined,
    removeListener: () => undefined
  }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../window/app-window-lookup', () => ({ registerChromeWindow: () => undefined }))
vi.mock('../window/privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: () => undefined
}))
vi.mock('./screen-geometry', () => ({ readScreenGeometry: () => Promise.resolve(new Map()) }))
// Keep the deferred path observable without real timers.
vi.mock('../appkit-scene-mutation', () => ({
  deferAppKitSceneMutation: (fn: () => void) => {
    order.push('deferred')
    fn()
  }
}))

const EMPTY_SUMMARY = { counts: { working: 0, attention: 0, done: 0 }, sessions: [] }

let mod: typeof NotchWindowModule
const realPlatform = process.platform

beforeEach(async () => {
  // Why: createNotchWindow returns null off darwin, so without this the whole suite silently
  // asserts nothing on Linux/Windows CI — `created` stays empty and the ordering expectations
  // fail. Pin it rather than skip, so the teardown contract is exercised on every host.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  created = []
  workspaceCalls.length = 0
  order.length = 0
  appHandlers.clear()
  vi.resetModules()
  mod = await import('./notch-window')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  vi.restoreAllMocks()
})

function create(): void {
  mod.createNotchWindow({
    getSummary: () => EMPTY_SUMMARY,
    subscribe: () => () => undefined,
    buildRows: () => []
  })
}

describe('notch window teardown', () => {
  it('exposes a quit teardown for index.ts to drive on before-quit', () => {
    // Why the registration lives in index.ts now: a vetoed quit has to restore the bar, and
    // only index.ts holds the settings + summary needed to re-create it.
    expect(typeof mod.closeNotchWindowForQuit).toBe('function')
  })

  it('destroys the window synchronously on quit, not a turn later', () => {
    // Why: a deferred destroy leaves the window alive past the quit decision, and
    // window-all-closed never fires — the app then cannot exit.
    create()
    order.length = 0

    mod.closeNotchWindowForQuit()

    expect(order).toEqual(['hide:1', 'destroy:1'])
    expect(order).not.toContain('deferred')
    expect(created[0].destroyed).toBe(true)
  })

  it('hides before destroying, since destroying a visible transparent panel kills the process', () => {
    create()
    order.length = 0

    mod.closeNotchWindowForQuit()

    expect(order.indexOf('hide:1')).toBeLessThan(order.indexOf('destroy:1'))
  })

  it('still defers the destroy on an ordinary settings-toggle close', () => {
    create()
    order.length = 0

    mod.closeNotchWindow()

    expect(order).toEqual(['hide:1', 'deferred', 'destroy:1'])
  })

  it('leaves no window behind after a quit', () => {
    create()
    mod.closeNotchWindowForQuit()

    expect(mod.getNotchWindow()).toBeNull()
  })

  it('is safe to tear down twice', () => {
    create()
    mod.closeNotchWindowForQuit()
    order.length = 0

    expect(() => mod.closeNotchWindowForQuit()).not.toThrow()
    expect(order).toEqual([])
  })

  it('never asks for fullscreen visibility, which would drop the app from Cmd+Tab', () => {
    // Why pinned: `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` makes
    // Electron demote the app to accessory — no Dock icon, absent from Cmd+Tab — and the
    // symptom looks nothing like its cause. Measured: with the option the app reports
    // UIElement, without it Foreground.
    create()

    expect(workspaceCalls).toContainEqual([true])
    expect(workspaceCalls.some((args) => args.length > 1)).toBe(false)
  })

  it('is safe to tear down when no window was ever created', () => {
    expect(() => mod.closeNotchWindowForQuit()).not.toThrow()
  })

  it('can create a fresh window after a quit teardown, so a vetoed quit can restore it', () => {
    create()
    mod.closeNotchWindowForQuit()
    create()

    expect(created).toHaveLength(2)
    expect(mod.getNotchWindow()).not.toBeNull()
  })

  it('clears expansion state on teardown so a restored bar opens collapsed', () => {
    create()
    mod.setNotchExpanded(true)
    expect(mod.isNotchExpanded()).toBe(true)

    mod.closeNotchWindowForQuit()

    expect(mod.isNotchExpanded()).toBe(false)
  })
})
