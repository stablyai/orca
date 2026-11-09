import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { appMock, isWindowlessLaunchMock } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const { vi } = await import('vitest')
  return { appMock: new EventEmitter(), isWindowlessLaunchMock: vi.fn(() => true) }
})
vi.mock('electron', () => ({
  app: appMock,
  screen: {
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 2560, height: 1440 } }]
  }
}))
vi.mock('./foreground-activation-policy', () => ({
  isWindowlessLaunch: () => isWindowlessLaunchMock(),
  showWindowWithoutStealingFocus: vi.fn()
}))
vi.mock('./main-window-visual-lifecycle', () => ({
  MIN_WIDTH: 480,
  MIN_HEIGHT: 360,
  syncTrafficLightPosition: vi.fn()
}))

import { installMainWindowStateLifecycle } from './main-window-state-lifecycle'

beforeEach(() => {
  vi.useFakeTimers()
  appMock.removeAllListeners()
  isWindowlessLaunchMock.mockReset()
  isWindowlessLaunchMock.mockReturnValue(true)
})
afterEach(() => vi.useRealTimers())

it('continues saving bounds after an updater quit veto and freezes them on allowed quit', async () => {
  const mainWindow = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), {
      send: vi.fn(),
      setZoomLevel: vi.fn()
    }),
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 })
  })
  const updateUI = vi.fn()
  const lifecycle = installMainWindowStateLifecycle({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements the window members read by the bounds lifecycle.
    mainWindow: mainWindow as never,
    revealOnDidFinishLoad: false,
    savedFullScreen: false,
    savedMaximized: false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Bounds persistence reads only updateUI from this store fixture.
    store: { updateUI } as never
  })
  appMock.emit('before-quit', { defaultPrevented: true })
  expect(lifecycle.isWindowClosing()).toBe(false)
  mainWindow.emit('resize')
  await vi.advanceTimersByTimeAsync(500)
  expect(updateUI).toHaveBeenCalledWith({
    windowMaximized: false,
    windowBounds: { x: 0, y: 0, width: 1200, height: 800 }
  })

  updateUI.mockClear()
  appMock.emit('before-quit', { defaultPrevented: false })
  expect(lifecycle.isWindowClosing()).toBe(true)
  mainWindow.emit('resize')
  await vi.advanceTimersByTimeAsync(500)
  expect(updateUI).not.toHaveBeenCalled()
  lifecycle.clearInitialRevealFallbackTimer()
  lifecycle.dispose()
})

const FULL_SCREEN_FRAME = { x: 0, y: 0, width: 2560, height: 1440 }

function fullscreenWindow(bounds: { x: number; y: number; width: number; height: number }) {
  const maximize = vi.fn()
  const setFullScreen = vi.fn()
  const mainWindow = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), {
      send: vi.fn(),
      setZoomLevel: vi.fn()
    }),
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => false,
    getBounds: () => bounds,
    maximize,
    setFullScreen
  })
  return { mainWindow, maximize, setFullScreen }
}

it('reopens a native fullscreen window, keeping maximize underneath it', () => {
  isWindowlessLaunchMock.mockReturnValue(false)
  const { mainWindow, maximize, setFullScreen } = fullscreenWindow({
    x: 40,
    y: 40,
    width: 1200,
    height: 800
  })
  const lifecycle = installMainWindowStateLifecycle({
    mainWindow: mainWindow as never,
    revealOnDidFinishLoad: false,
    savedFullScreen: true,
    savedMaximized: true,
    store: { updateUI: vi.fn() } as never
  })

  mainWindow.emit('ready-to-show')

  expect(maximize).toHaveBeenCalledOnce()
  expect(setFullScreen).toHaveBeenCalledOnce()
  expect(setFullScreen).toHaveBeenCalledWith(true)
  lifecycle.dispose()
})

it('reopens native fullscreen without maximizing a window that was not maximized', () => {
  isWindowlessLaunchMock.mockReturnValue(false)
  const { mainWindow, maximize, setFullScreen } = fullscreenWindow({
    x: 40,
    y: 40,
    width: 1200,
    height: 800
  })
  const lifecycle = installMainWindowStateLifecycle({
    mainWindow: mainWindow as never,
    revealOnDidFinishLoad: false,
    savedFullScreen: true,
    savedMaximized: false,
    store: { updateUI: vi.fn() } as never
  })

  mainWindow.emit('ready-to-show')

  expect(maximize).not.toHaveBeenCalled()
  expect(setFullScreen).toHaveBeenCalledWith(true)
  lifecycle.dispose()
})

it('does not store the fullscreen frame when unmaximize fires during fullscreen', () => {
  const { mainWindow } = fullscreenWindow(FULL_SCREEN_FRAME)
  const updateUI = vi.fn()
  const lifecycle = installMainWindowStateLifecycle({
    mainWindow: mainWindow as never,
    revealOnDidFinishLoad: false,
    savedFullScreen: false,
    savedMaximized: true,
    store: { updateUI } as never
  })

  mainWindow.emit('unmaximize')

  expect(updateUI).not.toHaveBeenCalled()
  lifecycle.dispose()
})

it('remembers native fullscreen without replacing the saved window size', () => {
  const { mainWindow } = fullscreenWindow({ x: 40, y: 40, width: 1200, height: 800 })
  const updateUI = vi.fn()
  const lifecycle = installMainWindowStateLifecycle({
    mainWindow: mainWindow as never,
    revealOnDidFinishLoad: false,
    savedFullScreen: false,
    savedMaximized: true,
    store: { updateUI } as never
  })

  mainWindow.emit('enter-full-screen')
  expect(updateUI).toHaveBeenCalledWith({ windowFullScreen: true })
  expect(updateUI).not.toHaveBeenCalledWith(
    expect.objectContaining({ windowBounds: expect.anything() })
  )

  updateUI.mockClear()
  mainWindow.emit('leave-full-screen')
  expect(updateUI).toHaveBeenCalledWith({ windowFullScreen: false })
  lifecycle.dispose()
})
