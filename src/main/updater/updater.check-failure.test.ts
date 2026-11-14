import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installNetRequestFetchAdapter } from './testing/updater-net-request.fixture'
import './releases/updater-prerelease-feed-reproduction.fixture'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import './testing/updater-test-main-window'

const { netFetchMock, netRequestMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  netRequestMock: vi.fn()
}))

const { appMock, browserWindowMock, nativeUpdaterMock, autoUpdaterMock, killAllPtyMock } =
  vi.hoisted(() => {
    const appEventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
    const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

    const appOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = appEventHandlers.get(event) ?? []
      handlers.push(handler)
      appEventHandlers.set(event, handlers)
      return appMock
    })

    const appPrependListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = appEventHandlers.get(event) ?? []
      handlers.unshift(handler)
      appEventHandlers.set(event, handlers)
      return appMock
    })

    const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = eventHandlers.get(event) ?? []
      handlers.push(handler)
      eventHandlers.set(event, handlers)
      return autoUpdaterMock
    })

    const emit = (event: string, ...args: unknown[]) => {
      for (const handler of eventHandlers.get(event) ?? []) {
        handler(...args)
      }
    }

    const reset = () => {
      appEventHandlers.clear()
      appOn.mockClear()
      appPrependListener.mockClear()
      eventHandlers.clear()
      on.mockClear()
      autoUpdaterMock.checkForUpdates.mockReset()
      autoUpdaterMock.downloadUpdate.mockReset()
      autoUpdaterMock.quitAndInstall.mockReset()
      autoUpdaterMock.setFeedURL.mockClear()
    }

    const autoUpdaterMock = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      on,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
      setFeedURL: vi.fn(),
      emit,
      reset
    }

    return {
      appMock: {
        isPackaged: true,
        getVersion: vi.fn(() => '1.0.51'),
        on: appOn,
        prependListener: appPrependListener,
        quit: vi.fn()
      },
      browserWindowMock: {
        getAllWindows: vi.fn(() => [])
      },
      nativeUpdaterMock: {
        on: vi.fn()
      },
      autoUpdaterMock,

      killAllPtyMock: vi.fn()
    }
  })

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: vi.fn() },
  net: { fetch: netFetchMock, request: netRequestMock }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock
}))

vi.mock('./electron-updater-loader', () => ({
  loadElectronAutoUpdater: () => autoUpdaterMock
}))

vi.mock('../ipc/pty/kill-all', () => ({ killAllPty: killAllPtyMock }))

vi.mock('./nudges/nudge-campaign', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))

function makeBenignCheckFailure(message: string): void {
  const error = new Error(message)
  autoUpdaterMock.checkForUpdates.mockImplementation(() => {
    autoUpdaterMock.emit('checking-for-update')
    queueMicrotask(() => {
      autoUpdaterMock.emit('error', error)
    })
    return Promise.reject(error)
  })
}

warmUpdaterModule()

describe('updater check failure handling', () => {
  beforeEach(() => {
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.quit.mockReset()
    appMock.isPackaged = true

    killAllPtyMock.mockReset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    netFetchMock.mockReset().mockImplementation(async (url: string) => {
      if (url.endsWith('/releases/latest')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/stablyai/orca/releases/tag/v1.0.51' }
        })
      }
      return new Response(
        url.endsWith('.atom')
          ? '<feed></feed>'
          : 'version: 1.0.51\nfiles:\n  - url: orca-windows-setup.exe\n'
      )
    })
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  it('records check failures without touching a destroyed main window', async () => {
    makeBenignCheckFailure('Unable to find latest version on GitHub')
    // Electron throws from a destroyed BrowserWindow's webContents getter.
    const mainWindow = {
      isDestroyed: () => true,
      get webContents(): never {
        throw new TypeError('Object has been destroyed')
      }
    }

    const { setupAutoUpdater, checkForUpdatesFromMenu, getUpdateStatus } = await loadUpdaterModule()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard only reads isDestroyed/webContents, which this partial BrowserWindow covers.
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() }) // ast-grep-ignore: test-no-wall-clock -- Suppress unrelated startup check.
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(getUpdateStatus()).toEqual(
        expect.objectContaining({ state: 'error', userInitiated: true })
      )
    })
  })
})
