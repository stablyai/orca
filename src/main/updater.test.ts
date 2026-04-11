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

    const appEmit = (event: string, ...args: unknown[]) => {
      for (const handler of appEventHandlers.get(event) ?? []) {
        handler(...args)
      }
    }

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
      autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null)
      autoUpdaterMock.downloadUpdate.mockReset()
      autoUpdaterMock.quitAndInstall.mockReset()
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
        emit: appEmit,
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
  autoUpdater: nativeUpdaterMock
}))

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('./ipc/pty', () => ({
  killAllPty: killAllPtyMock
}))

describe('updater', () => {
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

  it('deduplicates identical check errors from the event and rejected promise', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('boom'))
      })
      return Promise.reject(new Error('boom'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'error', message: 'boom', userInitiated: true })
    })

    const errorStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter((status) => typeof status === 'object' && status !== null && status.state === 'error')

    expect(errorStatuses).toEqual([{ state: 'error', message: 'boom', userInitiated: true }])
  })

  it('treats net::ERR_FAILED during checks as a benign idle transition', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'idle' })
    })

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual({ state: 'checking', userInitiated: true })
    expect(statuses).toContainEqual({ state: 'idle' })
    expect(statuses).not.toContainEqual(
      expect.objectContaining({ state: 'error', message: 'net::ERR_FAILED' })
    )
  })

  it('defers quitAndInstall through the shared main-process entrypoint', async () => {
    vi.useFakeTimers()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()

    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(99)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('ignores duplicate quitAndInstall requests while the shared delay is pending', async () => {
    vi.useFakeTimers()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('runs a startup check immediately when the last background check is stale', async () => {
    const mainWindow = { webContents: { send: vi.fn() } }
    const setLastUpdateCheckAt = vi.fn()

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now() - 37 * 60 * 60 * 1000,
      setLastUpdateCheckAt
    })

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()
  })

  it('waits until the remaining interval before the next background check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    const mainWindow = { webContents: { send: vi.fn() } }
    const setLastUpdateCheckAt = vi.fn()

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now() - 35 * 60 * 60 * 1000,
      setLastUpdateCheckAt
    })

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    vi.advanceTimersByTime(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()
  })

  it('retries background checks sooner after a failed automatic check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('boom'))
      })
      return Promise.reject(new Error('boom'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    await vi.runAllTicks()
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('reschedules the next automatic check 36 hours after finding an available update', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.runAllTicks()

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(setLastUpdateCheckAt).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.61'
    })

    vi.advanceTimersByTime(35 * 60 * 60 * 1000 + 59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})
