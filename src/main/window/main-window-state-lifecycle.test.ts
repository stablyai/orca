import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { appMock, autoUpdaterMock } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { appMock: new EventEmitter(), autoUpdaterMock: new EventEmitter() }
})
vi.mock('electron', () => ({ app: appMock, autoUpdater: autoUpdaterMock }))
vi.mock('./foreground-activation-policy', () => ({
  isBackgroundLaunch: () => true,
  isWindowlessLaunch: () => true,
  showWindowWithoutStealingFocus: vi.fn()
}))
vi.mock('./main-window-visual-lifecycle', () => ({
  MIN_WIDTH: 480,
  MIN_HEIGHT: 360,
  syncTrafficLightPosition: vi.fn()
}))

import { installMainWindowStateLifecycle } from './main-window-state-lifecycle'
import { withPlatform } from './createMainWindow-test-harness'

beforeEach(() => {
  vi.useFakeTimers()
  appMock.removeAllListeners()
  autoUpdaterMock.removeAllListeners()
})
afterEach(() => vi.useRealTimers())

function createStateFixture() {
  const bounds = { x: 1440, y: 40, width: 1200, height: 800 }
  const mainWindow = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { send: vi.fn() }),
    isDestroyed: () => false,
    isMinimized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    getBounds: vi.fn(() => bounds),
    getNormalBounds: () => bounds
  })
  const updateUI = vi.fn()
  const lifecycle = installMainWindowStateLifecycle({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements the window members read by the state lifecycle.
    mainWindow: mainWindow as never,
    revealOnDidFinishLoad: false,
    savedMaximized: false,
    savedFullscreen: false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These tests exercise only UI updates on the store.
    store: { updateUI } as never
  })
  return { mainWindow, updateUI, lifecycle, bounds }
}

it.each(['darwin', 'win32'] as const)(
  'saves pending bounds before native update closes windows ahead of before-quit on %s',
  (platform) =>
    withPlatform(platform, () => {
      const { mainWindow, updateUI, lifecycle, bounds } = createStateFixture()
      mainWindow.emit('resize')
      autoUpdaterMock.emit('before-quit-for-update')
      Object.assign(mainWindow, { isDestroyed: () => true })
      appMock.emit('before-quit', { defaultPrevented: false })
      vi.advanceTimersByTime(500)
      expect(updateUI).toHaveBeenCalledExactlyOnceWith({
        windowMaximized: false,
        windowBounds: bounds
      })
      lifecycle.dispose()
      expect(autoUpdaterMock.listenerCount('before-quit-for-update')).toBe(0)
    })
)

it('freezes native-update fullscreen state before teardown emits leave-full-screen', () => {
  withPlatform('darwin', () => {
    const { mainWindow, updateUI, lifecycle } = createStateFixture()
    mainWindow.isFullScreen.mockReturnValue(true)
    mainWindow.emit('enter-full-screen')
    autoUpdaterMock.emit('before-quit-for-update')
    updateUI.mockClear()
    mainWindow.isFullScreen.mockReturnValue(false)
    mainWindow.emit('leave-full-screen')
    Object.assign(mainWindow, { isDestroyed: () => true })
    appMock.emit('before-quit', { defaultPrevented: false })
    expect(updateUI).not.toHaveBeenCalled()
    lifecycle.dispose()
  })
})

it('keeps maximized restore bounds on the original monitor through update teardown', () => {
  const { mainWindow, updateUI, lifecycle, bounds } = createStateFixture()
  mainWindow.isMaximized.mockReturnValue(true)
  mainWindow.getBounds.mockReturnValue({ x: 1440, y: 0, width: 1920, height: 1080 })
  mainWindow.emit('maximize')
  expect(updateUI).toHaveBeenLastCalledWith({ windowMaximized: true, windowBounds: bounds })
  mainWindow.emit('resize')
  appMock.emit('before-quit', { defaultPrevented: false })
  updateUI.mockClear()
  mainWindow.isMaximized.mockReturnValue(false)
  mainWindow.emit('unmaximize')
  mainWindow.emit('resize')
  vi.advanceTimersByTime(500)
  expect(updateUI).not.toHaveBeenCalled()
  lifecycle.dispose()
})

it('remembers fullscreen but ignores leave-full-screen during update teardown', () => {
  const { mainWindow, updateUI, lifecycle } = createStateFixture()
  mainWindow.isFullScreen.mockReturnValue(true)
  mainWindow.emit('enter-full-screen')
  expect(updateUI).toHaveBeenLastCalledWith({ windowFullscreen: true })
  mainWindow.emit('resize')
  vi.advanceTimersByTime(500)
  expect(updateUI).toHaveBeenCalledOnce()
  mainWindow.isFullScreen.mockReturnValue(false)
  mainWindow.emit('leave-full-screen')
  expect(updateUI).toHaveBeenLastCalledWith({ windowFullscreen: false })
  mainWindow.isFullScreen.mockReturnValue(true)
  mainWindow.emit('enter-full-screen')
  appMock.emit('before-quit', { defaultPrevented: false })
  updateUI.mockClear()
  mainWindow.isFullScreen.mockReturnValue(false)
  mainWindow.emit('leave-full-screen')
  expect(updateUI).not.toHaveBeenCalled()
  lifecycle.dispose()
})

it('keeps usable bounds when minimized or torn down to the minimum size', () => {
  const { mainWindow, updateUI, lifecycle } = createStateFixture()
  mainWindow.isMinimized.mockReturnValue(true)
  mainWindow.emit('resize')
  vi.advanceTimersByTime(500)
  expect(updateUI).not.toHaveBeenCalled()
  mainWindow.isMinimized.mockReturnValue(false)
  mainWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 480, height: 360 })
  mainWindow.emit('resize')
  appMock.emit('before-quit', { defaultPrevented: false })
  expect(updateUI).toHaveBeenCalledExactlyOnceWith({ windowMaximized: false })
  lifecycle.dispose()
})

it('saves the latest resized window before an update quit cancels the debounce', () => {
  let bounds = { x: 40, y: 60, width: 1200, height: 800 }
  const mainWindow = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(),
    isDestroyed: () => false,
    isMinimized: () => false,
    isFullScreen: () => false,
    isMaximized: () => false,
    getBounds: () => bounds
  })
  const updateUI = vi.fn()
  const lifecycle = installMainWindowStateLifecycle({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements the window members read by the state lifecycle.
    mainWindow: mainWindow as never,
    revealOnDidFinishLoad: false,
    savedMaximized: false,
    savedFullscreen: false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test exercises only UI updates on the store.
    store: { updateUI } as never
  })

  bounds = { x: 1440, y: 0, width: 1920, height: 1080 }
  mainWindow.emit('resize')
  appMock.emit('before-quit', { defaultPrevented: false })
  expect(updateUI).toHaveBeenLastCalledWith({ windowMaximized: false, windowBounds: bounds })

  updateUI.mockClear()
  bounds = { x: 0, y: 0, width: 480, height: 360 }
  mainWindow.emit('resize')
  vi.advanceTimersByTime(500)
  expect(updateUI).not.toHaveBeenCalled()
  lifecycle.dispose()
})

it('continues saving bounds after an updater quit veto and freezes them on allowed quit', async () => {
  const mainWindow = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), {
      send: vi.fn(),
      setZoomLevel: vi.fn()
    }),
    isDestroyed: () => false,
    isMinimized: () => false,
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
    savedFullscreen: false,
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
  updateUI.mockClear()
  mainWindow.emit('resize')
  await vi.advanceTimersByTimeAsync(500)
  expect(updateUI).not.toHaveBeenCalled()
  lifecycle.clearInitialRevealFallbackTimer()
  lifecycle.dispose()
})
