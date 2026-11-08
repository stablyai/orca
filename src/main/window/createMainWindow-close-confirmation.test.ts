import { beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('../browser/routing/sessions/browser-route-session-runtime', async () => {
  const harness = await import('./createMainWindow-test-harness')
  return {
    browserRouteSessionRegistry: { isAllowedPartition: harness.routePartitionAllowedMock },
    browserRouteWebContentsRegistry: {
      attachGuest: harness.attachRouteGuestMock,
      retireRenderer: harness.retireRouteRendererMock
    }
  }
})
vi.mock('../browser/client-pages/renderer/browser-client-page-renderer-runtime', async () => {
  const harness = await import('./createMainWindow-test-harness')
  return {
    attachBrowserClientPageRenderer: harness.attachClientPageRendererMock,
    retireBrowserClientPageRenderer: harness.retireClientPageRendererMock
  }
})

import { createMainWindow, WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS } from './createMainWindow'
import { ipcMain } from 'electron'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import {
  attachClientPageRendererMock,
  browserWindowMock,
  createRendererRecoveryWindowHarness,
  resetMainWindowMocks,
  retireClientPageRendererMock,
  retireRouteRendererMock
} from './createMainWindow-test-harness'

describe('createMainWindow', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('sends the next close as a plain close once its renderer cancels the newest quit request', () => {
    const ipcHandlers: Record<string, (...args: any[]) => void> = {}
    vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
      ipcHandlers[channel] = handler as (...args: any[]) => void
      return ipcMain
    })
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()
    let isQuitting = true
    createMainWindow(null, {
      getIsQuitting: () => isQuitting,
      onQuitAborted: () => {
        isQuitting = false
      }
    })
    const cancel = (senderId: number): void =>
      ipcHandlers['window:close-cancelled']?.({ sender: { id: senderId } })
    const retryClose = (): unknown => {
      windowHandlers.close({ preventDefault: vi.fn() } as never)
      return browserWindowInstance.webContents.send.mock.lastCall
    }

    expect(retryClose()).toEqual(['window:close-requested', { isQuitting: true, requestId: 1 }])
    // Why: a cancel sent before the renderer saw this quit belongs to an older prompt.
    cancel(143)
    ipcHandlers['window:close-request-received']?.({ sender: { id: 143 } }, 1)
    cancel(99)
    expect(retryClose()).toEqual(['window:close-requested', { isQuitting: true, requestId: 2 }])
    ipcHandlers['window:close-request-received']?.({ sender: { id: 143 } }, 2)
    cancel(143)
    expect(retryClose()).toEqual(['window:close-requested', { isQuitting: false, requestId: 3 }])
  })

  it('allows close after the renderer process is gone', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      id: 71,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      setWebRTCIPHandlingPolicy: vi.fn(),
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
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
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
    expect(retireRouteRendererMock).toHaveBeenCalledWith(71)
    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith(
      'window:close-requested',
      expect.objectContaining({ isQuitting: true })
    )

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
      setWebRTCIPHandlingPolicy: vi.fn(),
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
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
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
      setWebRTCIPHandlingPolicy: vi.fn(),
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
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
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
    expect(retireClientPageRendererMock).toHaveBeenCalledWith(webContents)
    expect(attachClientPageRendererMock).toHaveBeenCalledWith(webContents)
    expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
      isQuitting: true,
      requestId: expect.any(Number)
    })

    consoleError.mockRestore()
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
      setWebRTCIPHandlingPolicy: vi.fn(),
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
        loadFile: vi.fn(() => Promise.resolve()),
        loadURL: vi.fn(() => Promise.resolve())
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
      setWebRTCIPHandlingPolicy: vi.fn(),
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
        loadFile: vi.fn(() => Promise.resolve()),
        loadURL: vi.fn(() => Promise.resolve())
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
