import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { createMainWindow, WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS } from './createMainWindow'
import { ipcMain } from 'electron'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

describe('createMainWindow', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('clears the quit latch when the renderer prevents unload', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    const onQuitAborted = vi.fn()
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null, { getIsQuitting: () => true, onQuitAborted })

    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
      isQuitting: true,
      requestId: expect.any(Number)
    })

    windowHandlers['will-prevent-unload']()
    expect(onQuitAborted).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('window:unload-prevented')
  })

  it('allows close after the renderer process is gone', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null, { getIsQuitting: () => true })

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as never
    )
    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith(
      'window:close-requested',
      expect.objectContaining({ isQuitting: true })
    )

    consoleError.mockRestore()
  })

  it('does not notify the crash recorder when renderer teardown follows a confirmed window close', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const ipcHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
      close: vi.fn(() => {
        windowHandlers.close({} as never)
      })
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
      ipcHandlers[channel] = handler as (...args: any[]) => void
      return ipcMain
    })
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })
    const onRendererProcessGone = vi.fn()

    createMainWindow(null, { onRendererProcessGone })

    ipcHandlers['window:confirm-close']?.()
    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'killed',
        exitCode: 9
      } as never
    )

    expect(onRendererProcessGone).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('does not persist pending bounds after bypassing close for a gone renderer', () => {
    vi.useFakeTimers()

    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      getBounds: vi.fn(() => ({ x: 10, y: 20, width: 1000, height: 700 })),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    const updateUI = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow({
      getUI: () => ({}),
      getSettings: () => ({ windowBackgroundBlur: false }),
      updateUI
    } as never)

    windowHandlers.resize()
    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as never
    )
    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)
    vi.advanceTimersByTime(500)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(updateUI).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('resumes close confirmation after a renderer process reloads', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null, { getIsQuitting: () => true })

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as never
    )
    windowHandlers['did-finish-load']?.()
    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
      isQuitting: true,
      requestId: expect.any(Number)
    })

    consoleError.mockRestore()
  })

  it('allows close when Electron reports a crashed webContents', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => true)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null, { getIsQuitting: () => true })

    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith(
      'window:close-requested',
      expect.objectContaining({ isQuitting: true })
    )
  })

  // Why (#5787): a hung-but-ALIVE renderer (never gone, never crashed) must NOT
  // silently bypass the close guard — force-killing it that way is what destroyed
  // other sessions. It must route through window:close-requested so the
  // save/running-process confirmation runs.
  it('requests confirmation for a hung-but-alive renderer instead of bypassing', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false)
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    // No render-process-gone and isCrashed() === false: the renderer is alive.
    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
      isQuitting: false,
      requestId: expect.any(Number)
    })
  })

  it('destroys an already-unresponsive renderer after an app-wide quit deadline', async () => {
    vi.useFakeTimers()
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      id: 42,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false)
    }
    const destroy = vi.fn()
    browserWindowMock.mockImplementation(function () {
      return {
        webContents,
        on: vi.fn((event, handler) => {
          windowHandlers[event] = handler
        }),
        isDestroyed: vi.fn(() => false),
        isMaximized: vi.fn(() => true),
        isFullScreen: vi.fn(() => false),
        getSize: vi.fn(() => [1200, 800]),
        setSize: vi.fn(),
        maximize: vi.fn(),
        show: vi.fn(),
        destroy,
        loadFile: vi.fn(),
        loadURL: vi.fn()
      }
    })
    createMainWindow(null, { getIsQuitting: () => true })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS - 1)
    expect(destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(destroy).toHaveBeenCalledOnce()
  })

  it('keeps the renderer-owned close flow after the quit request is acknowledged', async () => {
    vi.useFakeTimers()
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const ipcHandlers: Record<string, (...args: any[]) => void> = {}
    vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
      ipcHandlers[channel] = handler as (...args: any[]) => void
      return ipcMain
    })
    const webContents = {
      id: 42,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isCrashed: vi.fn(() => false)
    }
    const destroy = vi.fn()
    browserWindowMock.mockImplementation(function () {
      return {
        webContents,
        on: vi.fn((event, handler) => {
          windowHandlers[event] = handler
        }),
        isDestroyed: vi.fn(() => false),
        isMaximized: vi.fn(() => true),
        isFullScreen: vi.fn(() => false),
        getSize: vi.fn(() => [1200, 800]),
        setSize: vi.fn(),
        maximize: vi.fn(),
        show: vi.fn(),
        destroy,
        loadFile: vi.fn(),
        loadURL: vi.fn()
      }
    })
    createMainWindow(null, { getIsQuitting: () => true })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    windowHandlers.close({ preventDefault: vi.fn() } as never)
    const closeRequests = vi
      .mocked(webContents.send)
      .mock.calls.filter(([channel]) => channel === 'window:close-requested')
      .map(([, request]) => request as { requestId: number })
    expect(closeRequests).toHaveLength(2)
    const [staleRequest, currentRequest] = closeRequests
    ipcHandlers['window:close-request-received']?.({ sender: { id: 99 } }, currentRequest.requestId)
    ipcHandlers['window:close-request-received']?.({ sender: { id: 42 } }, staleRequest.requestId)
    await vi.advanceTimersByTimeAsync(WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS - 1)
    expect(destroy).not.toHaveBeenCalled()
    ipcHandlers['window:close-request-received']?.({ sender: { id: 42 } }, currentRequest.requestId)
    await vi.advanceTimersByTimeAsync(1)

    expect(destroy).not.toHaveBeenCalled()
  })
})
