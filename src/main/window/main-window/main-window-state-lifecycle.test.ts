import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { appMock, launchPolicy } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { appMock: new EventEmitter(), launchPolicy: { background: false, windowless: true } }
})
vi.mock('electron', () => ({ app: appMock }))
vi.mock('../activation/foreground-activation-policy', () => ({
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
