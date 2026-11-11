import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { appMock, launchPolicy } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { appMock: new EventEmitter(), launchPolicy: { background: false, windowless: true } }
})
vi.mock('electron', () => ({ app: appMock }))
vi.mock('./foreground-activation-policy', () => ({
  isBackgroundLaunch: () => launchPolicy.background,
  isWindowlessLaunch: () => launchPolicy.windowless,
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
  launchPolicy.background = false
  launchPolicy.windowless = true
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
    savedMaximized: false,
    savedFullScreen: false,
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

function installFullScreenFixture(): {
  lifecycle: ReturnType<typeof installMainWindowStateLifecycle>
  mainWindow: EventEmitter & { setFullScreen: (flag: boolean) => void }
  windowState: { maximized: boolean; fullScreen: boolean; maximizedUnderFullScreen: boolean }
  persisted: Record<string, unknown>
} {
  launchPolicy.windowless = false
  const windowState = { maximized: false, fullScreen: false, maximizedUnderFullScreen: false }
  const mainWindow = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { send: vi.fn(), setZoomLevel: vi.fn() }),
    isDestroyed: () => false,
    isFullScreen: () => windowState.fullScreen,
    getBounds: () => ({ x: 0, y: 0, width: 2560, height: 1440 }),
    maximize: () => {
      windowState.maximized = true
    },
    setFullScreen: (flag: boolean) => {
      if (flag) {
        windowState.maximizedUnderFullScreen = windowState.maximized
      }
      windowState.fullScreen = flag
    }
  })
  const persisted: Record<string, unknown> = {}
  const lifecycle = installMainWindowStateLifecycle({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements the window members read by reveal and fullscreen persistence.
    mainWindow: mainWindow as never,
    revealOnDidFinishLoad: false,
    savedMaximized: true,
    savedFullScreen: true,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fullscreen persistence reads only updateUI from this store fixture.
    store: {
      updateUI: (patch: Record<string, unknown>) => Object.assign(persisted, patch)
    } as never
  })
  return { lifecycle, mainWindow, windowState, persisted }
}

it('restores native fullscreen over the maximized frame and keeps that frame while fullscreen', () => {
  const { lifecycle, mainWindow, windowState, persisted } = installFullScreenFixture()
  const leaveFullScreen = (): void => {
    mainWindow.setFullScreen(false)
    mainWindow.emit('leave-full-screen')
  }
  mainWindow.emit('ready-to-show')
  expect(windowState).toEqual({ maximized: true, fullScreen: true, maximizedUnderFullScreen: true })
  // macOS emits unmaximize mid-transition, after the fullscreen style mask is set.
  mainWindow.emit('unmaximize')
  mainWindow.emit('enter-full-screen')
  expect(persisted).toEqual({ windowFullScreen: true })

  leaveFullScreen()
  expect(persisted).toEqual({ windowFullScreen: false })
  mainWindow.emit('unmaximize')
  expect(persisted).toEqual({
    windowFullScreen: false,
    windowMaximized: false,
    windowBounds: { x: 0, y: 0, width: 2560, height: 1440 }
  })

  mainWindow.setFullScreen(true)
  mainWindow.emit('enter-full-screen')
  appMock.emit('before-quit', { defaultPrevented: false })
  leaveFullScreen()
  expect(persisted).toMatchObject({ windowFullScreen: true })
  lifecycle.clearInitialRevealFallbackTimer()
  lifecycle.dispose()
})

it('does not restore native fullscreen for background launches', () => {
  launchPolicy.background = true
  const { lifecycle, mainWindow, windowState } = installFullScreenFixture()
  mainWindow.emit('ready-to-show')
  expect(windowState).toEqual({
    maximized: true,
    fullScreen: false,
    maximizedUnderFullScreen: false
  })
  lifecycle.clearInitialRevealFallbackTimer()
  lifecycle.dispose()
})
