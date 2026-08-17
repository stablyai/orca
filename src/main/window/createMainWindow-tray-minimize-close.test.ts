import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import {
  resetExpectedTeardownStateForTest,
  resolveExpectedTeardownScope,
  WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
} from '../crash-reporting/expected-teardown-state'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot
} from '../crash-reporting/crash-breadcrumb-store'
import {
  browserWindowMock,
  notificationMock,
  notificationShowMock,
  resetMainWindowMocks
} from './createMainWindow-test-harness'

describe('createMainWindow', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    clearCrashBreadcrumbsForTest()
    vi.useRealTimers()
  })

  describe('minimize to tray on close (win32)', () => {
    const originalPlatform = process.platform

    function setPlatform(platform: NodeJS.Platform): void {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    }

    type CloseFixture = {
      windowHandlers: Record<string, (...args: any[]) => void>
      webContents: { send: ReturnType<typeof vi.fn> }
      instance: { hide: ReturnType<typeof vi.fn>; isMinimized: ReturnType<typeof vi.fn> }
    }

    function setupCloseWindow(): CloseFixture {
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
        loadFile: vi.fn(),
        loadURL: vi.fn()
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

    afterEach(() => {
      setPlatform(originalPlatform)
      clearCrashBreadcrumbsForTest()
    })

    it('marks production teardown state on irrevocable Windows session end', () => {
      setPlatform('win32')
      resetExpectedTeardownStateForTest(() => 1_000)
      const { windowHandlers } = setupCloseWindow()

      createMainWindow(null)
      windowHandlers['session-end']?.({} as never)

      expect(
        resolveExpectedTeardownScope({
          isQuitting: false,
          isQuittingForUpdate: false,
          isExpectedRendererReload: false
        })
      ).toBe('app-shutdown')
    })

    it('durably records the session-end reasons so bundles can identify OS shutdown', () => {
      setPlatform('win32')
      const { windowHandlers } = setupCloseWindow()

      createMainWindow(null)
      windowHandlers['session-end']?.({ reasons: ['shutdown', 'critical'] } as never)
      windowHandlers['session-end']?.({} as never)

      expect(getCrashBreadcrumbSnapshot()).toEqual([
        expect.objectContaining({
          name: 'system_session_end',
          data: expect.objectContaining({ reasons: 'shutdown,critical' })
        }),
        expect.objectContaining({
          name: 'system_session_end',
          data: expect.objectContaining({ reasons: '' })
        })
      ])
    })

    it.each(['darwin', 'linux'] as const)(
      'does not mark session teardown state on %s',
      (platform) => {
        setPlatform(platform)
        const { windowHandlers } = setupCloseWindow()

        createMainWindow(null)

        expect(windowHandlers['session-end']).toBeUndefined()
        expect(
          resolveExpectedTeardownScope({
            isQuitting: false,
            isQuittingForUpdate: false,
            isExpectedRendererReload: false
          })
        ).toBe('none')
      }
    )

    it('still minimizes to tray after the session-end reporting window expires', () => {
      setPlatform('win32')
      let now = 1_000
      resetExpectedTeardownStateForTest(() => now)
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never)
      windowHandlers['session-end']?.({} as never)
      now += WINDOWS_SESSION_END_CRASH_SUPPRESSION_WINDOW_MS
      const preventDefault = vi.fn()
      windowHandlers.close({ preventDefault } as never)

      expect(preventDefault).toHaveBeenCalledOnce()
      expect(instance.hide).toHaveBeenCalledOnce()
      expect(webContents.send).not.toHaveBeenCalledWith('window:close-requested', expect.anything())
    })

    it('hides to the tray instead of closing when the setting is on', () => {
      setPlatform('win32')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      const preventDefault = vi.fn()
      windowHandlers.close({ preventDefault } as never)

      expect(preventDefault).toHaveBeenCalled()
      expect(instance.hide).toHaveBeenCalledTimes(1)
      expect(webContents.send).not.toHaveBeenCalledWith('window:close-requested', expect.anything())
      // Notice already shown, so it must not fire again.
      expect(notificationMock).not.toHaveBeenCalled()
    })

    it('keeps the normal close flow when the setting is off', () => {
      setPlatform('win32')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(false, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
        isQuitting: false,
        requestId: expect.any(Number)
      })
    })

    it('does not hide on a real quit even with the setting on', () => {
      setPlatform('win32')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => true })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
        isQuitting: true,
        requestId: expect.any(Number)
      })
    })

    it('does not hide when the renderer process is gone', () => {
      setPlatform('win32')
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { windowHandlers, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      windowHandlers['render-process-gone']?.(
        {} as never,
        { reason: 'crashed', exitCode: 5 } as never
      )
      const preventDefault = vi.fn()
      windowHandlers.close({ preventDefault } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(preventDefault).not.toHaveBeenCalled()
      consoleError.mockRestore()
    })

    it('shows the first-run notification once and persists the flag', () => {
      setPlatform('win32')
      const { windowHandlers } = setupCloseWindow()
      const store = makeStore(true, false)

      createMainWindow(store as never, { getIsQuitting: () => false })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(notificationMock).toHaveBeenCalledTimes(1)
      expect(notificationShowMock).toHaveBeenCalledTimes(1)
      expect(store.updateUI).toHaveBeenCalledWith({ trayMinimizeNoticeShown: true })
    })

    it('leaves the close handler unchanged off win32', () => {
      setPlatform('darwin')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
        isQuitting: false,
        requestId: expect.any(Number)
      })
    })

    // Why: on Windows the renderer-drawn X routes through window:request-close,
    // not the native close event — regression guard for the bug where the app
    // quit instead of hiding because the guard only covered the native event.
    function captureIpcHandlers(): Record<string, (...args: any[]) => void> {
      const ipcHandlers: Record<string, (...args: any[]) => void> = {}
      vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
        ipcHandlers[channel] = handler as (...args: any[]) => void
        return ipcMain
      })
      return ipcHandlers
    }

    it('hides to the tray when the renderer-drawn X requests close', () => {
      setPlatform('win32')
      const ipcHandlers = captureIpcHandlers()
      const { webContents, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      ipcHandlers['window:request-close']?.()

      expect(instance.hide).toHaveBeenCalledTimes(1)
      expect(webContents.send).not.toHaveBeenCalledWith('window:close-requested', expect.anything())
    })

    it('forwards window:request-close to the renderer when the setting is off', () => {
      setPlatform('win32')
      const ipcHandlers = captureIpcHandlers()
      const { webContents, instance } = setupCloseWindow()
      const store = makeStore(false, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      ipcHandlers['window:request-close']?.()

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
        isQuitting: false
      })
    })
  })
})
