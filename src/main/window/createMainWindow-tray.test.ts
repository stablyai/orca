/* oxlint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  browserWindowMock,
  openExternalMock,
  attachGuestPoliciesMock,
  buildFromTemplateMock,
  menuPopupMock,
  notificationMock,
  notificationShowMock,
  powerMonitorOnMock,
  powerMonitorRemoveListenerMock,
  isMock
} = vi.hoisted(() => {
  const menuPopupMock = vi.fn()
  const notificationShowMock = vi.fn()
  return {
    browserWindowMock: vi.fn(),
    openExternalMock: vi.fn(),
    attachGuestPoliciesMock: vi.fn(),
    buildFromTemplateMock: vi.fn(() => ({ popup: menuPopupMock })),
    menuPopupMock,
    notificationMock: vi.fn(function () {
      return { show: notificationShowMock }
    }),
    notificationShowMock,
    powerMonitorOnMock: vi.fn(),
    powerMonitorRemoveListenerMock: vi.fn(),
    isMock: { dev: false }
  }
})

vi.mock('electron', () => ({
  app: { on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: browserWindowMock,
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  Menu: { buildFromTemplate: buildFromTemplateMock },
  Notification: notificationMock,
  nativeTheme: { shouldUseDarkColors: false },
  powerMonitor: { on: powerMonitorOnMock, removeListener: powerMonitorRemoveListenerMock },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } })
  },
  shell: { openExternal: openExternalMock }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('../app-icon', () => ({
  getAppIconPath: vi.fn(() => 'icon')
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    attachGuestPolicies: attachGuestPoliciesMock,
    setDictationShortcutForwardingPredicate: vi.fn()
  }
}))

import { createMainWindow } from './createMainWindow'
import { ipcMain } from 'electron'

describe('createMainWindow', () => {
  beforeEach(() => {
    browserWindowMock.mockReset()
    openExternalMock.mockReset()
    attachGuestPoliciesMock.mockReset()
    buildFromTemplateMock.mockClear()
    menuPopupMock.mockClear()
    notificationMock.mockClear()
    notificationShowMock.mockClear()
    powerMonitorOnMock.mockReset()
    powerMonitorRemoveListenerMock.mockReset()
    isMock.dev = false
    vi.mocked(ipcMain.on).mockReset()
    vi.mocked(ipcMain.removeListener).mockReset()
    vi.mocked(ipcMain.handle).mockReset()
    vi.mocked(ipcMain.removeHandler).mockReset()
    vi.useRealTimers()
  })


  describe('minimize to tray on close (desktop tray platforms)', () => {
    const originalPlatform = process.platform
    const trayPlatforms = ['win32', 'linux'] as const

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

    afterEach(() => {
      setPlatform(originalPlatform)
    })

    it.each(trayPlatforms)(
      'hides to the tray instead of closing when the setting is on for %s',
      (platform) => {
        setPlatform(platform)
        const { windowHandlers, webContents, instance } = setupCloseWindow()
        const store = makeStore(true, true)

        createMainWindow(store as never, { getIsQuitting: () => false })
        const preventDefault = vi.fn()
        windowHandlers.close({ preventDefault } as never)

        expect(preventDefault).toHaveBeenCalled()
        expect(instance.hide).toHaveBeenCalledTimes(1)
        expect(webContents.send).not.toHaveBeenCalledWith(
          'window:close-requested',
          expect.anything()
        )
        // Notice already shown, so it must not fire again.
        expect(notificationMock).not.toHaveBeenCalled()
      }
    )

    it('keeps the normal close flow when the setting is off', () => {
      setPlatform('win32')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(false, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith(
        'window:close-requested',
        expect.objectContaining({ isQuitting: false })
      )
    })

    it('keeps the normal close flow when the setting is off on Linux', () => {
      setPlatform('linux')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(false, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith(
        'window:close-requested',
        expect.objectContaining({ isQuitting: false })
      )
    })

    it('does not hide on a real quit even with the setting on', () => {
      setPlatform('win32')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => true })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith(
        'window:close-requested',
        expect.objectContaining({ isQuitting: true })
      )
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

    it('leaves the close handler unchanged on macOS', () => {
      setPlatform('darwin')
      const { windowHandlers, webContents, instance } = setupCloseWindow()
      const store = makeStore(true, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      windowHandlers.close({ preventDefault: vi.fn() } as never)

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith(
        'window:close-requested',
        expect.objectContaining({ isQuitting: false })
      )
    })

    // Why: the renderer-drawn X routes through window:request-close,
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

    it.each(trayPlatforms)(
      'hides to the tray when the renderer-drawn X requests close on %s',
      (platform) => {
        setPlatform(platform)
        const ipcHandlers = captureIpcHandlers()
        const { webContents, instance } = setupCloseWindow()
        const store = makeStore(true, true)

        createMainWindow(store as never, { getIsQuitting: () => false })
        ipcHandlers['window:request-close']?.()

        expect(instance.hide).toHaveBeenCalledTimes(1)
        expect(webContents.send).not.toHaveBeenCalledWith(
          'window:close-requested',
          expect.anything()
        )
      }
    )

    it('forwards window:request-close to the renderer when the setting is off', () => {
      setPlatform('win32')
      const ipcHandlers = captureIpcHandlers()
      const { webContents, instance } = setupCloseWindow()
      const store = makeStore(false, true)

      createMainWindow(store as never, { getIsQuitting: () => false })
      ipcHandlers['window:request-close']?.()

      expect(instance.hide).not.toHaveBeenCalled()
      expect(webContents.send).toHaveBeenCalledWith(
        'window:close-requested',
        expect.objectContaining({ isQuitting: false })
      )
    })
  })
})
