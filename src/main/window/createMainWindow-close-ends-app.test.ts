import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('./desktop-integration/app-icon', async () =>
  (await import('./createMainWindow-test-harness')).appIconMock()
)
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { createMainWindow } from './createMainWindow'
import { ipcMain } from 'electron'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

describe('createMainWindow close that ends the app (win32)', () => {
  const originalPlatform = process.platform

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }

  type CloseFixture = {
    windowHandlers: Record<string, (...args: any[]) => void>
    webContents: { send: ReturnType<typeof vi.fn> }
    instance: { hide: ReturnType<typeof vi.fn> }
  }

  function setupCloseWindow(): CloseFixture {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      setWebRTCIPHandlingPolicy: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false),
      id: 1
    }
    const instance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
    }
    browserWindowMock.mockImplementation(function () {
      return instance
    })
    return { windowHandlers, webContents, instance }
  }

  function makeStore(minimizeToTrayOnClose: boolean, trayMinimizeNoticeShown: boolean) {
    return {
      getUI: vi.fn(() => ({ trayMinimizeNoticeShown })),
      getSettings: vi.fn(() => ({ windowBackgroundBlur: false, minimizeToTrayOnClose })),
      updateUI: vi.fn()
    }
  }

  function captureIpcHandlers(): Record<string, (...args: any[]) => void> {
    const ipcHandlers: Record<string, (...args: any[]) => void> = {}
    vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
      ipcHandlers[channel] = handler
      return ipcMain
    })
    return ipcHandlers
  }

  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
    setPlatform('win32')
  })

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('asks the renderer for quit semantics when the renderer-drawn X ends the app', () => {
    const ipcHandlers = captureIpcHandlers()
    const { webContents } = setupCloseWindow()

    createMainWindow(null, { getIsQuitting: () => false, getWindowCloseEndsApp: () => true })
    ipcHandlers['window:request-close']?.()

    expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
      isQuitting: true
    })
  })

  it('asks the renderer for quit semantics when a native close (Alt+F4) ends the app', () => {
    const { windowHandlers, webContents } = setupCloseWindow()

    createMainWindow(null, { getIsQuitting: () => false, getWindowCloseEndsApp: () => true })
    windowHandlers.close({ preventDefault: vi.fn() })

    expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
      isQuitting: true,
      requestId: expect.any(Number)
    })
  })

  it('still hides to the tray instead of asking when the close would end the app', () => {
    const ipcHandlers = captureIpcHandlers()
    const { webContents, instance } = setupCloseWindow()

    createMainWindow(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tray guard reads only getSettings/getUI/updateUI, which makeStore provides.
      makeStore(true, true) as never,
      { getIsQuitting: () => false, getWindowCloseEndsApp: () => true }
    )
    ipcHandlers['window:request-close']?.()

    expect(instance.hide).toHaveBeenCalledTimes(1)
    expect(webContents.send).not.toHaveBeenCalledWith('window:close-requested', expect.anything())
  })
})
