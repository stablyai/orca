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

import { createMainWindow } from './createMainWindow'
import { ipcMain } from 'electron'
import { shouldRecoverRendererAfterProcessGone } from '../crash-reporting/process-gone-classification'
import {
  resetExpectedTeardownStateForTest,
  resolveExpectedTeardownScope
} from '../crash-reporting/expected-teardown-state'
import {
  browserWindowMock,
  resetMainWindowMocks,
  withPlatform
} from './createMainWindow-test-harness'

describe('createMainWindow', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('does not read destroyed webContents during closed cleanup', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    let webContentsDestroyed = false
    const browserWindowInstance = {
      get webContents() {
        if (webContentsDestroyed) {
          throw new Error('Object has been destroyed')
        }
        return webContents
      },
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

    webContentsDestroyed = true

    // Why: Electron may destroy webContents before BrowserWindow's `closed`
    // cleanup runs during updater shutdown. The cleanup must not crash, or
    // Squirrel.Mac never reaches the relaunch step.
    expect(() => windowHandlers.closed?.()).not.toThrow()
  })

  it('resets the markdown editor focus flag on renderer crash, navigation, and destroy', () => {
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
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
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

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setMarkdownEditorFocused')?.[1]
    const isDarwin = process.platform === 'darwin'

    const cmdBInput = {
      type: 'keyDown',
      code: 'KeyB',
      key: 'b',
      meta: isDarwin,
      control: !isDarwin,
      alt: false,
      shift: false
    } as never

    const assertInterceptsAfterReset = (): void => {
      webContents.send.mockClear()
      const preventDefault = vi.fn()
      windowHandlers['before-input-event']({ preventDefault } as never, cmdBInput)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(webContents.send).toHaveBeenCalledWith('ui:toggleLeftSidebar')
    }

    // render-process-gone
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['render-process-gone']?.()
    assertInterceptsAfterReset()

    // did-start-navigation (main frame)
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['did-start-navigation']?.({} as never, 'https://example.com/', false, true)
    assertInterceptsAfterReset()

    // did-start-navigation (sub-frame) should NOT reset the flag
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['did-start-navigation']?.({} as never, 'https://example.com/', false, false)
    webContents.send.mockClear()
    const subframePreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: subframePreventDefault } as never,
      cmdBInput
    )
    expect(subframePreventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:toggleLeftSidebar')

    // destroyed
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['destroyed']?.()
    assertInterceptsAfterReset()
  })

  it('notifies the caller when the renderer process is gone', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      id: 142,
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
      on: vi.fn(),
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
    const onRendererProcessGone = vi.fn()

    createMainWindow(null, { onRendererProcessGone })

    const details = { reason: 'crashed', exitCode: 5 } as Electron.RenderProcessGoneDetails
    windowHandlers['render-process-gone']?.({} as never, details)

    expect(onRendererProcessGone).toHaveBeenCalledWith(details, 142)
  })

  it('passes the renderer webContents id through crash recording and recovery callbacks', () => {
    vi.useFakeTimers()

    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      id: 424,
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
      on: vi.fn(),
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
    const onRendererProcessGone = vi.fn()
    const shouldRecoverRenderer = vi.fn(() => true)

    try {
      createMainWindow(null, {
        onRendererProcessGone,
        shouldRecoverRenderer
      })

      const details = { reason: 'crashed', exitCode: 5 } as Electron.RenderProcessGoneDetails
      windowHandlers['render-process-gone']?.({} as never, details)
      vi.advanceTimersByTime(250)

      expect(onRendererProcessGone).toHaveBeenCalledWith(details, 424)
      expect(shouldRecoverRenderer).toHaveBeenCalledWith(details, 424)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('forwards expected renderer teardowns so the recorder can diagnose suppression', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      id: 142,
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
      on: vi.fn(),
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
    const onRendererProcessGone = vi.fn()

    createMainWindow(null, { onRendererProcessGone })

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'killed',
        exitCode: 15
      } as Electron.RenderProcessGoneDetails
    )

    expect(onRendererProcessGone).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'killed', exitCode: 15 }),
      expect.any(Number)
    )

    consoleError.mockRestore()
  })

  const createRendererRecoveryWindowHarness = () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      id: 143,
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
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    return { browserWindowInstance, windowHandlers }
  }

  it('reloads the app shell after an unexpected renderer process loss', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null)

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as Electron.RenderProcessGoneDetails
    )
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('still preserves PTYs and reloads after Windows session-end', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()
    const onBeforeRecoveryReload = vi.fn()

    withPlatform('win32', () => {
      createMainWindow(null, {
        onBeforeRecoveryReload,
        shouldRecoverRenderer: (details) =>
          shouldRecoverRendererAfterProcessGone({
            reason: details.reason,
            expectedTeardown: resolveExpectedTeardownScope({
              isQuitting: false,
              isQuittingForUpdate: false,
              isExpectedRendererReload: false,
              includeSystemSessionEnd: false
            })
          })
      })
    })
    windowHandlers['session-end']?.({} as never)
    windowHandlers['render-process-gone']?.(
      {} as never,
      { reason: 'killed', exitCode: 1 } as Electron.RenderProcessGoneDetails
    )
    vi.runAllTimers()

    expect(onBeforeRecoveryReload).toHaveBeenCalledWith(143)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
  })

  it('does not reload after renderer loss when recovery is disabled', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null, { shouldRecoverRenderer: () => false })

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as Electron.RenderProcessGoneDetails
    )
    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('rechecks the renderer recovery predicate before reloading', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()
    let shouldRecover = true

    createMainWindow(null, { shouldRecoverRenderer: () => shouldRecover })

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as Electron.RenderProcessGoneDetails
    )
    shouldRecover = false
    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('coalesces repeated renderer losses into one recovery reload', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null)

    const details = {
      reason: 'crashed',
      exitCode: 5
    } as Electron.RenderProcessGoneDetails
    windowHandlers['render-process-gone']?.({} as never, details)
    windowHandlers['render-process-gone']?.({} as never, details)
    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('does not reload after a clean renderer exit', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null)

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'clean-exit',
        exitCode: 0
      } as Electron.RenderProcessGoneDetails
    )
    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('cancels renderer recovery when the crashed window is closing', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null)

    windowHandlers['render-process-gone']?.(
      {} as never,
      {
        reason: 'crashed',
        exitCode: 5
      } as Electron.RenderProcessGoneDetails
    )
    windowHandlers.close({ preventDefault: vi.fn() } as never)
    vi.advanceTimersByTime(250)

    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadURL).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('stops auto-reloading after a rapid renderer crash loop trips the breaker', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null, { onRendererRecoveryExhausted })

    const details = { reason: 'crashed', exitCode: 5 } as Electron.RenderProcessGoneDetails
    // Each cycle: renderer dies, breaker allows the first 3 reloads, then opens.
    const driveCrashCycle = (): void => {
      windowHandlers['render-process-gone']?.({} as never, details)
      vi.advanceTimersByTime(250)
    }
    driveCrashCycle()
    driveCrashCycle()
    driveCrashCycle()
    // 1 initial load + 3 recoveries.
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    // 4th crash within the window: breaker is open, no further reload.
    driveCrashCycle()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ recentRecoveryCount: 3 })
    )

    consoleError.mockRestore()
  })

  it('bounds renderer launch-failed recovery with the crash-loop breaker', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    try {
      createMainWindow(null, {
        onRendererRecoveryExhausted,
        shouldRecoverRenderer: (details) =>
          shouldRecoverRendererAfterProcessGone({
            reason: details.reason,
            expectedTeardown: 'none'
          })
      })

      const details = {
        reason: 'launch-failed',
        exitCode: 18
      } as Electron.RenderProcessGoneDetails
      const driveLaunchFailure = (): void => {
        windowHandlers['render-process-gone']?.({} as never, details)
        vi.advanceTimersByTime(250)
      }

      driveLaunchFailure()
      driveLaunchFailure()
      driveLaunchFailure()
      expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)

      driveLaunchFailure()
      expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)
      expect(onRendererRecoveryExhausted).toHaveBeenCalledOnce()
      expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
        expect.objectContaining({ details, recentRecoveryCount: 3 })
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
