import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Rect = { x: number; y: number; width: number; height: number }

const { instances, BrowserWindowMock, getAllDisplaysMock, getPrimaryDisplayMock, isMock } =
  vi.hoisted(() => {
    const created: FakeWindow[] = []

    class FakeWindow {
      options: Electron.BrowserWindowConstructorOptions
      destroyed = false
      bounds: Rect
      private handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
      private onceHandlers: Record<string, ((...args: unknown[]) => void)[]> = {}
      webContents = {
        id: created.length + 1,
        send: vi.fn(),
        isDestroyed: () => this.destroyed,
        session: {
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn()
        },
        on: vi.fn()
      }
      showInactive = vi.fn()
      loadURL = vi.fn()
      loadFile = vi.fn()
      setAlwaysOnTop = vi.fn()
      setVisibleOnAllWorkspaces = vi.fn()
      setIgnoreMouseEvents = vi.fn()
      setPosition = vi.fn((x: number, y: number) => {
        this.bounds = { ...this.bounds, x, y }
      })
      setBounds = vi.fn((next: Rect) => {
        this.bounds = next
      })
      getBounds = vi.fn(() => this.bounds)
      isDestroyed = (): boolean => this.destroyed
      destroy = vi.fn(() => {
        this.destroyed = true
        this.emit('closed')
      })

      constructor(options: Electron.BrowserWindowConstructorOptions) {
        this.options = options
        this.bounds = {
          x: options.x ?? 0,
          y: options.y ?? 0,
          width: options.width ?? 0,
          height: options.height ?? 0
        }
        created.push(this)
      }

      on(event: string, cb: (...args: unknown[]) => void): this {
        ;(this.handlers[event] ||= []).push(cb)
        return this
      }
      once(event: string, cb: (...args: unknown[]) => void): this {
        ;(this.onceHandlers[event] ||= []).push(cb)
        return this
      }
      emit(event: string, ...args: unknown[]): void {
        for (const cb of this.handlers[event] ?? []) {
          cb(...args)
        }
        for (const cb of this.onceHandlers[event] ?? []) {
          cb(...args)
        }
        this.onceHandlers[event] = []
      }
    }

    const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
    return {
      instances: created,
      BrowserWindowMock: FakeWindow,
      getAllDisplaysMock: vi.fn(() => [primary]),
      getPrimaryDisplayMock: vi.fn(() => primary),
      isMock: { dev: false }
    }
  })

vi.mock('electron', () => ({
  BrowserWindow: BrowserWindowMock,
  screen: { getAllDisplays: getAllDisplaysMock, getPrimaryDisplay: getPrimaryDisplayMock }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: isMock }))
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: vi.fn()
}))

import {
  closeDesktopPetWindow,
  createOrRevealDesktopPetWindow,
  getDesktopPetWindow,
  moveDesktopPetWindow,
  setDesktopPetInteractive
} from './desktop-pet-window'
import { PET_WINDOW_MARGIN } from '../../shared/pet-window-geometry'

function createStore(ui: Record<string, unknown> = {}) {
  const listeners: ((ui: Record<string, unknown>) => void)[] = []
  const store = {
    ui: { petSize: 180, ...ui },
    getUI: () => store.ui,
    updateUI: vi.fn((partial: Record<string, unknown>) => {
      Object.assign(store.ui, partial)
    }),
    onUIChanged: (listener: (ui: Record<string, unknown>) => void) => {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
    emitUIChanged: () => listeners.forEach((listener) => listener(store.ui))
  }
  return store
}

describe('desktop pet window', () => {
  beforeEach(() => {
    instances.length = 0
  })

  afterEach(() => {
    closeDesktopPetWindow()
    vi.clearAllMocks()
    getAllDisplaysMock.mockReturnValue([{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }])
  })

  it('opens frameless, transparent, and above other windows without stealing focus', () => {
    createOrRevealDesktopPetWindow(createStore() as never)
    const options = instances[0]!.options
    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.skipTaskbar).toBe(true)
    expect(options.focusable).toBe(false)
    expect(options.resizable).toBe(false)
    expect(instances[0]!.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')

    instances[0]!.emit('ready-to-show')
    expect(instances[0]!.showInactive).toHaveBeenCalled()
  })

  it('sizes the window to the persisted pet size plus its bob margin', () => {
    createOrRevealDesktopPetWindow(createStore({ petSize: 240 }) as never)
    expect(instances[0]!.options.width).toBe(240 + PET_WINDOW_MARGIN * 2)
    expect(instances[0]!.options.height).toBe(240 + PET_WINDOW_MARGIN * 2)
  })

  it('resizes in place when the user drags the size slider', () => {
    const store = createStore({ petSize: 180 })
    createOrRevealDesktopPetWindow(store as never)
    store.ui.petSize = 300
    store.emitUIChanged()
    expect(instances[0]!.bounds.width).toBe(300 + PET_WINDOW_MARGIN * 2)
  })

  it('reveals the existing window instead of opening a second pet', () => {
    const store = createStore()
    createOrRevealDesktopPetWindow(store as never)
    createOrRevealDesktopPetWindow(store as never)
    expect(instances).toHaveLength(1)
    expect(instances[0]!.showInactive).toHaveBeenCalled()
  })

  it('restores a saved position', () => {
    createOrRevealDesktopPetWindow(createStore({ petWindowPosition: { x: 640, y: 320 } }) as never)
    expect(instances[0]!.options.x).toBe(640)
    expect(instances[0]!.options.y).toBe(320)
  })

  it('falls back to the work-area corner when the saved position is off every display', () => {
    createOrRevealDesktopPetWindow(
      createStore({ petWindowPosition: { x: 9000, y: 9000 } }) as never
    )
    expect(instances[0]!.options.x).toBeLessThan(1920)
    expect(instances[0]!.options.y).toBeLessThan(1080)
  })

  it('persists a drag so the pet returns to the same spot next launch', () => {
    const store = createStore()
    createOrRevealDesktopPetWindow(store as never)
    moveDesktopPetWindow(store as never, { x: 400, y: 200 })
    expect(instances[0]!.setPosition).toHaveBeenCalledWith(400, 200)
    expect(store.updateUI).toHaveBeenCalledWith({ petWindowPosition: { x: 400, y: 200 } })
  })

  it('refuses a drag that would strand the pet off-screen', () => {
    const store = createStore()
    createOrRevealDesktopPetWindow(store as never)
    moveDesktopPetWindow(store as never, { x: 5000, y: 5000 })
    expect(instances[0]!.setPosition).not.toHaveBeenCalled()
    expect(store.updateUI).not.toHaveBeenCalled()
  })

  it('passes clicks through when the pointer is off the pet, and takes them back when on it', () => {
    createOrRevealDesktopPetWindow(createStore() as never)
    setDesktopPetInteractive(false)
    expect(instances[0]!.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
    setDesktopPetInteractive(true)
    expect(instances[0]!.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
  })

  it('drops its singleton on close so a later detach opens a fresh window', () => {
    const store = createStore()
    createOrRevealDesktopPetWindow(store as never)
    closeDesktopPetWindow()
    expect(instances[0]!.destroy).toHaveBeenCalled()
    expect(getDesktopPetWindow()).toBe(null)

    createOrRevealDesktopPetWindow(store as never)
    expect(instances).toHaveLength(2)
  })
})
