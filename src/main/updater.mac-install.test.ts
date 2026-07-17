import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appMock,
  browserWindowMock,
  nativeUpdaterMock,
  autoUpdaterMock,
  shellMock,
  isMock,
  killAllPtyMock
} = vi.hoisted(() => {
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
    autoUpdaterMock.checkForUpdates.mockReset()
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
      getPath: vi.fn(() => '/tmp/orca-test-user-data'),
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
    shellMock: {
      openExternal: vi.fn()
    },
    isMock: { dev: false },
    killAllPtyMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: vi.fn() },
  shell: shellMock,
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

vi.mock('./updater-changelog', () => ({
  fetchChangelog: vi.fn().mockResolvedValue(null)
}))

vi.mock('./updater-nudge', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))

const findConflictingAppInstancePidsMock = vi.hoisted(() => vi.fn(async () => [] as number[]))
vi.mock('./updater-conflicting-app-instances', () => ({
  findConflictingAppInstancePids: findConflictingAppInstancePidsMock
}))

const { writeHandoffMarkerMock, clearHandoffMarkerMock } = vi.hoisted(() => ({
  writeHandoffMarkerMock: vi.fn(),
  clearHandoffMarkerMock: vi.fn()
}))
vi.mock('./startup/update-install-launch-gate', () => ({
  writeUpdateInstallHandoffMarker: writeHandoffMarkerMock,
  clearUpdateInstallHandoffMarker: clearHandoffMarkerMock
}))

describe('updater mac install handoff', () => {
  beforeEach(() => {
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    shellMock.openExternal.mockReset()
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.quit.mockReset()
    appMock.isPackaged = true
    isMock.dev = false
    killAllPtyMock.mockReset()
    findConflictingAppInstancePidsMock.mockReset()
    findConflictingAppInstancePidsMock.mockResolvedValue([])
    writeHandoffMarkerMock.mockReset()
    clearHandoffMarkerMock.mockReset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.runIf(process.platform === 'darwin')(
    'blocks the install handoff while another instance of the app bundle is running',
    async () => {
      const sendMock = vi.fn()
      const mainWindow = { webContents: { send: sendMock } }

      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      const { setupAutoUpdater, quitAndInstall } = await import('./updater')

      setupAutoUpdater(mainWindow as never)
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      autoUpdaterMock.emit('checking-for-update')
      autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      await new Promise((r) => setTimeout(r, 0))
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })
      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      nativeDownloadedHandler?.()

      findConflictingAppInstancePidsMock.mockImplementation(async () => {
        // Why: without the marker already published, a new app can launch
        // after this snapshot and recreate Squirrel's silent install stall.
        expect(writeHandoffMarkerMock).toHaveBeenCalledWith(
          '/tmp/orca-test-user-data',
          process.execPath,
          '1.0.51'
        )
        return [4242]
      })
      quitAndInstall()
      await vi.waitFor(() => {
        expect(sendMock).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({
            state: 'error',
            message: expect.stringContaining('PID 4242'),
            retryAction: 'install'
          })
        )
      })
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(clearHandoffMarkerMock).toHaveBeenCalledWith(
        '/tmp/orca-test-user-data',
        process.execPath
      )

      // Once the conflicting instance is gone, a retry must install normally.
      findConflictingAppInstancePidsMock.mockResolvedValue([])
      quitAndInstall()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true)
      })
      // The retry publishes a fresh marker before the native call.
      expect(writeHandoffMarkerMock).toHaveBeenCalledTimes(2)
      expect(writeHandoffMarkerMock.mock.invocationCallOrder[1]).toBeLessThan(
        autoUpdaterMock.quitAndInstall.mock.invocationCallOrder[0]
      )
    }
  )

  it.runIf(process.platform === 'darwin')(
    'waits for Squirrel.Mac before honoring a manual quit that should install the update',
    async () => {
      const sendMock = vi.fn()
      const mainWindow = { webContents: { send: sendMock } }

      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      const { setupAutoUpdater } = await import('./updater')

      setupAutoUpdater(mainWindow as never)
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      autoUpdaterMock.emit('checking-for-update')
      autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      // Why: the update-available handler is now async (it awaits fetchChangelog).
      // Flush microtasks so setAvailableVersion runs before update-downloaded fires.
      await new Promise((r) => setTimeout(r, 0))
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      const preventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault })

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      expect(nativeDownloadedHandler).toBeTypeOf('function')

      nativeDownloadedHandler?.()

      await vi.waitFor(() => {
        expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true)
      })
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'downloading',
        percent: 100,
        version: '1.0.61'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'checks for blocking instances after pre-quit cleanup settles',
    async () => {
      let finishCleanup!: () => void
      const onBeforeQuit = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCleanup = resolve
          })
      )
      const sendMock = vi.fn()
      const mainWindow = { webContents: { send: sendMock } }

      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      const { setupAutoUpdater, quitAndInstall } = await import('./updater')

      setupAutoUpdater(mainWindow as never, { onBeforeQuit })
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      autoUpdaterMock.emit('checking-for-update')
      autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })
      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      nativeDownloadedHandler?.()

      quitAndInstall()
      await vi.waitFor(() => {
        expect(onBeforeQuit).toHaveBeenCalledTimes(1)
      })
      expect(findConflictingAppInstancePidsMock).not.toHaveBeenCalled()

      // Why: this models an agent/test instance launching during the bounded
      // cleanup window; the last-moment scan must see it before ShipIt starts.
      findConflictingAppInstancePidsMock.mockResolvedValue([4242])
      finishCleanup()

      await vi.waitFor(() => {
        expect(sendMock).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({ state: 'error', retryAction: 'install' })
        )
      })
      expect(findConflictingAppInstancePidsMock).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
    }
  )

  it.runIf(process.platform === 'darwin')(
    'ignores duplicate quit requests while deferred mac install cleanup is running',
    async () => {
      vi.useFakeTimers()

      let finishCleanup!: () => void
      const onBeforeQuit = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCleanup = resolve
          })
      )
      const mainWindow = { webContents: { send: vi.fn() } }

      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      const { setupAutoUpdater, quitAndInstall } = await import('./updater')

      setupAutoUpdater(mainWindow as never, { onBeforeQuit })
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      autoUpdaterMock.emit('checking-for-update')
      autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      const preventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault })
      expect(preventDefault).toHaveBeenCalledTimes(1)

      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      expect(nativeDownloadedHandler).toBeTypeOf('function')

      nativeDownloadedHandler?.()
      await vi.advanceTimersByTimeAsync(0)

      expect(onBeforeQuit).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

      quitAndInstall()
      finishCleanup()
      await vi.advanceTimersByTimeAsync(0)

      expect(onBeforeQuit).toHaveBeenCalledTimes(1)
      expect(killAllPtyMock).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    }
  )

  it.runIf(process.platform === 'darwin')(
    'logs rejected deferred mac install handoffs without unhandled rejection',
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const reportDownloaded = vi.fn()
      const { deferMacQuitUntilInstallerReady, handleMacInstallerReady } =
        await import('./updater-mac-install')

      expect(
        deferMacQuitUntilInstallerReady(
          { state: 'downloading', percent: 100, version: '1.0.61' },
          true,
          () => '1.0.61',
          vi.fn()
        )
      ).toBe(true)

      handleMacInstallerReady(
        true,
        async () => {
          throw new Error('handoff-secret')
        },
        reportDownloaded
      )
      await Promise.resolve()

      expect(reportDownloaded).not.toHaveBeenCalled()
      await vi.waitFor(() => {
        // Why: recordUpdaterLifecycle packs metadata into one console line.
        expect(warn).toHaveBeenCalledWith(
          '[updater] Deferred macOS install handoff failed {"errorType":"Error"}'
        )
      })
      expect(JSON.stringify(warn.mock.calls)).not.toContain('handoff-secret')
    }
  )

  it.runIf(process.platform === 'darwin')(
    'falls back to a normal quit if Squirrel.Mac never becomes ready',
    async () => {
      vi.useFakeTimers()

      const sendMock = vi.fn()
      const mainWindow = { webContents: { send: sendMock } }

      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      const { setupAutoUpdater } = await import('./updater')

      setupAutoUpdater(mainWindow as never)
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      autoUpdaterMock.emit('checking-for-update')
      autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      // Why: the update-available handler is now async (it awaits fetchChangelog).
      // Flush microtasks so setAvailableVersion runs before update-downloaded fires.
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      const preventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault })

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(appMock.quit).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(15000)

      expect(appMock.quit).toHaveBeenCalledTimes(1)

      const secondPreventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault: secondPreventDefault })
      expect(secondPreventDefault).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    }
  )
})
