import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)
vi.mock('../browser/browser-client-page-renderer-runtime', async () => {
  const harness = await import('./createMainWindow-test-harness')
  return {
    attachBrowserClientPageRenderer: harness.attachClientPageRendererMock,
    retireBrowserClientPageRenderer: harness.retireClientPageRendererMock
  }
})

import { createMainWindow } from './createMainWindow'
import { ipcMain } from 'electron'
import { shouldRecoverRendererAfterProcessGone } from '../crash-reporting/process-gone-classification'
import {
  resetExpectedTeardownStateForTest,
  resolveExpectedTeardownScope
} from '../crash-reporting/expected-teardown-state'
import {
  attachClientPageRendererMock,
  browserWindowMock,
  createRendererRecoveryWindowHarness,
  resetMainWindowMocks,
  retireClientPageRendererMock,
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
      setWebRTCIPHandlingPolicy: vi.fn(),
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
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    webContentsDestroyed = true

    // Updater teardown may destroy WebContents before closed cleanup; throwing would prevent Squirrel relaunch.
    expect(() => windowHandlers.closed?.()).not.toThrow()
  })

  it('retires renderer generations and resets focus on crash, navigation, and destroy', async () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      getURL: vi.fn(() => 'file:///opt/orca/renderer/index.html'),
      isDestroyed: vi.fn(() => false),
      isLoadingMainFrame: vi.fn(() => false),
      mainFrame: {},
      on: vi.fn((event, handler) => {
        // Retain multiple lifecycle listeners like EventEmitter.
        const previous = windowHandlers[event]
        windowHandlers[event] = previous
          ? (...args: unknown[]) => {
              previous(...args)
              handler(...args)
            }
          : handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      setWebRTCIPHandlingPolicy: vi.fn(),
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
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)
    windowHandlers['did-finish-load']?.()
    expect(attachClientPageRendererMock).toHaveBeenCalledWith(webContents)

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

    retireClientPageRendererMock.mockClear()
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['render-process-gone']?.()
    expect(retireClientPageRendererMock).toHaveBeenCalledWith(webContents)
    assertInterceptsAfterReset()
    windowHandlers['did-finish-load']?.()

    retireClientPageRendererMock.mockClear()
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['did-start-navigation']?.({} as never, 'https://example.com/', false, true)
    expect(retireClientPageRendererMock).not.toHaveBeenCalled()

    windowHandlers['did-start-navigation']?.(
      {} as never,
      'file:///opt/orca/renderer/index.html?reload=1',
      false,
      true
    )
    expect(retireClientPageRendererMock).toHaveBeenCalledWith(webContents)
    assertInterceptsAfterReset()

    attachClientPageRendererMock.mockClear()
    windowHandlers['did-fail-provisional-load']?.(
      {} as never,
      -3,
      'aborted',
      'file:///opt/orca/renderer/index.html?reload=1',
      true
    )
    await Promise.resolve()
    expect(attachClientPageRendererMock).toHaveBeenCalledWith(webContents)

    retireClientPageRendererMock.mockClear()
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['did-start-navigation']?.({} as never, '#same-document', true, true)
    expect(retireClientPageRendererMock).not.toHaveBeenCalled()
    windowHandlers['did-start-navigation']?.({} as never, 'https://example.com/', false, false)
    expect(retireClientPageRendererMock).not.toHaveBeenCalled()
    webContents.send.mockClear()
    const subframePreventDefault = vi.fn()
    windowHandlers['before-input-event'](
      { preventDefault: subframePreventDefault } as never,
      cmdBInput
    )
    expect(subframePreventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:toggleLeftSidebar')

    retireClientPageRendererMock.mockClear()
    setFocusedListener?.({ sender: webContents } as never, true)
    windowHandlers['destroyed']?.()
    expect(retireClientPageRendererMock).toHaveBeenCalledWith(webContents)
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
      setWebRTCIPHandlingPolicy: vi.fn(),
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
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })
    const onRendererProcessGone = vi.fn()

    createMainWindow(null, { onRendererProcessGone })

    const details = { reason: 'crashed', exitCode: 5 } as Electron.RenderProcessGoneDetails
    windowHandlers['render-process-gone']?.({} as never, details)

    expect(onRendererProcessGone).toHaveBeenCalledWith(
      details,
      142,
      expect.objectContaining({ rendererDocumentLoaded: false })
    )
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
      setWebRTCIPHandlingPolicy: vi.fn(),
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
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
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

      expect(onRendererProcessGone).toHaveBeenCalledWith(
        details,
        424,
        expect.objectContaining({ rendererDocumentLoaded: false })
      )
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
      setWebRTCIPHandlingPolicy: vi.fn(),
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
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
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
      expect.any(Number),
      expect.any(Object)
    )

    consoleError.mockRestore()
  })

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
    const onRendererRecoveryExhausted = vi.fn()

    withPlatform('win32', () => {
      createMainWindow(null, {
        onBeforeRecoveryReload,
        onRendererRecoveryExhausted,
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
    vi.advanceTimersByTime(250)

    expect(onBeforeRecoveryReload).toHaveBeenCalledWith(143, 'automatic')
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    // Deliberate logoff reloads must never raise recovery dialogs during teardown.
    vi.runAllTimers()
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
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
    // Allow three renderer-death reloads, then open the breaker.
    const driveCrashCycle = (): void => {
      windowHandlers['render-process-gone']?.({} as never, details)
      vi.advanceTimersByTime(250)
    }
    driveCrashCycle()
    driveCrashCycle()
    driveCrashCycle()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    driveCrashCycle()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ recentRecoveryCount: 3 })
    )

    consoleError.mockRestore()
  })

  it('serves a manual retry while the breaker stays open for the next crash', () => {
    vi.useFakeTimers()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, windowHandlers } = createRendererRecoveryWindowHarness()

    createMainWindow(null, { onRendererRecoveryExhausted })

    const details = { reason: 'crashed', exitCode: 5 } as Electron.RenderProcessGoneDetails
    const driveCrashCycle = (): void => {
      windowHandlers['render-process-gone']?.({} as never, details)
      vi.advanceTimersByTime(250)
    }
    driveCrashCycle()
    driveCrashCycle()
    driveCrashCycle()
    driveCrashCycle()
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)

    // Manual watched retry bypasses the automatic-recovery breaker.
    onRendererRecoveryExhausted.mock.calls[0]?.[0].retry()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(5)

    // Manual retry must not reset the poisoned machine's automatic-reload breaker.
    driveCrashCycle()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(5)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(2)

    consoleError.mockRestore()
  })
})
