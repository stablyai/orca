import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appMock, browserWindowMock, nativeUpdaterMock, autoUpdaterMock, isMock, killAllPtyMock } =
  vi.hoisted(() => {
    const appEventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
    const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

    const appOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = appEventHandlers.get(event) ?? []
      handlers.push(handler)
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
        quit: vi.fn()
      },
      browserWindowMock: {
        getAllWindows: vi.fn(() => [])
      },
      nativeUpdaterMock: {
        on: vi.fn()
      },
      autoUpdaterMock,
      isMock: { dev: false },
      killAllPtyMock: vi.fn()
    }
  })

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: vi.fn() },
  net: { fetch: vi.fn() }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock
}))

vi.mock('./electron-updater-loader', () => ({
  loadElectronAutoUpdater: () => autoUpdaterMock
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('./ipc/pty', () => ({
  killAllPty: killAllPtyMock
}))

vi.mock('./updater-nudge', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))

const ONE_HOUR_MS = 60 * 60 * 1000
const THIRTY_SECONDS_MS = 30 * 1000
const FRIENDLY_MESSAGE = "Couldn't reach the update server. Try again in a few minutes."

function makeBenignCheckFailure(message: string): void {
  autoUpdaterMock.checkForUpdates.mockImplementation(() => {
    autoUpdaterMock.emit('checking-for-update')
    queueMicrotask(() => {
      autoUpdaterMock.emit('error', new Error(message))
    })
    return Promise.reject(new Error(message))
  })
}

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
    isMock.dev = false
    killAllPtyMock.mockReset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('surfaces GitHub release-transition failures with calmer copy and no short retry', async () => {
    vi.useFakeTimers()
    makeBenignCheckFailure('Unable to find latest version on GitHub')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(0)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual({ state: 'checking', userInitiated: true })
    expect(statuses).toContainEqual(
      expect.objectContaining({
        state: 'error',
        userInitiated: true,
        message: FRIENDLY_MESSAGE
      })
    )
    expect(statuses).not.toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('Unable to find latest version') })
    )
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(THIRTY_SECONDS_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('surfaces missing latest-mac.yml to user-initiated checks with calmer copy', async () => {
    makeBenignCheckFailure('Cannot find channel "latest-mac.yml" update info: HttpError: 404')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: FRIENDLY_MESSAGE
        })
      )
      expect(statuses).not.toContainEqual(
        expect.objectContaining({ state: 'not-available', userInitiated: true })
      )
    })
  })

  it('silently drops background benign failures to idle and waits for the hourly retry', async () => {
    vi.useFakeTimers()
    makeBenignCheckFailure('Unable to find latest version on GitHub')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdates } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdates()

    await vi.advanceTimersByTimeAsync(0)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual({ state: 'idle' })
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(THIRTY_SECONDS_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS - THIRTY_SECONDS_MS)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})
