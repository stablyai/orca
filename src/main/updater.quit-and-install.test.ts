import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PRE_COMMIT_INSTALL_FAILURE } from './updater-test-harness'

const {
  nativeUpdaterMock,
  autoUpdaterMock,
  killAllPtyMock,
  armExitWatchdogMock,
  disarmExitWatchdogMock,
  fetchNewerReleaseTagsMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

const { launchPathScope } = vi.hoisted(() => ({
  launchPathScope: { active: false, calls: 0 }
}))

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())
vi.mock('./startup/hydrate-shell-path', () => ({
  runWithLaunchPath: (action: () => unknown): unknown => {
    launchPathScope.active = true
    launchPathScope.calls += 1
    try {
      return action()
    } finally {
      launchPathScope.active = false
    }
  }
}))

describe('updater', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    launchPathScope.active = false
    launchPathScope.calls = 0
  })

  it('still surfaces updater error events while a download is in flight', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })
    autoUpdaterMock.downloadUpdate.mockImplementation(() => {
      autoUpdaterMock.emit('error', new Error('download failed'))
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.0.61',
        changelog: null
      })
    })

    sendMock.mockClear()
    downloadUpdate()

    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error', message: 'download failed' })
    )
  })

  it('surfaces an accepted retry before electron-updater emits download progress', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })
    autoUpdaterMock.downloadUpdate
      .mockRejectedValueOnce(new Error('signature check blocked'))
      .mockImplementationOnce(() => new Promise(() => {}))
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.0.61',
        changelog: null
      })
    })

    downloadUpdate()
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'signature check blocked'
      })
    })

    sendMock.mockClear()
    downloadUpdate()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'downloading',
      percent: 0,
      version: '1.0.61'
    })

    downloadUpdate()
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('defers quitAndInstall and runs its launcher within the launch PATH scope', async () => {
    vi.useFakeTimers()
    let launcherSawLaunchPathScope = false
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      launcherSawLaunchPathScope = launchPathScope.active
    })

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
    expect(launcherSawLaunchPathScope).toBe(true)
    expect(launchPathScope.calls).toBe(1)
    expect(launchPathScope.active).toBe(false)
  })

  it('runs pre-quit cleanup before local PTY cleanup during update install', async () => {
    vi.useFakeTimers()

    const onBeforeQuit = vi.fn()
    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { onBeforeQuit })
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(killAllPtyMock).toHaveBeenCalledTimes(1)
    expect(onBeforeQuit.mock.invocationCallOrder[0]).toBeLessThan(
      killAllPtyMock.mock.invocationCallOrder[0]
    )
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

  it('ignores duplicate quitAndInstall requests while async pre-quit cleanup is running', async () => {
    vi.useFakeTimers()

    let finishCleanup!: () => void
    const onBeforeQuit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { onBeforeQuit })
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

    quitAndInstall()
    finishCleanup()
    await vi.advanceTimersByTimeAsync(0)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('recovers quit-for-update state on sync quitAndInstall error event without killing PTYs', async () => {
    vi.useFakeTimers()

    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      // Why: BaseUpdater dispatches 'error' synchronously inside install() for the common "no staged update filepath" path.
      autoUpdaterMock.emit(
        'error',
        new Error("No update filepath provided, can't quit and install")
      )
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(isQuittingForUpdate()).toBe(false)
    // Why: destructive prep runs only after quitAndInstall returns still in progress; sync recovery clears flags first so PTYs stay alive.
    expect(killAllPtyMock).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({
        state: 'error',
        // Why: a pre-commit install failure is not fixed by restarting, so the copy must not
        // suggest it — except on macOS, where quitting does re-stage a Squirrel update.
        // The updater's own text is appended because it is the only record of why the install never ran.
        message: `${PRE_COMMIT_INSTALL_FAILURE} (No update filepath provided, can't quit and install)`
      })
    )
  })

  it('does not recover quit-for-update state from late errors after install commit', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, checkForUpdatesFromMenu, quitAndInstall, isQuittingForUpdate } =
      await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    // Why: reach the downloaded state so a late post-commit error isn't mistaken for a download/install UI failure.
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.0.61',
        changelog: null
      })
    })

    autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

    // Why: on macOS install commits only once Squirrel is ready; mark it ready so this test covers the post-commit path on all platforms.
    if (process.platform === 'darwin') {
      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      expect(nativeDownloadedHandler).toBeTypeOf('function')
      nativeDownloadedHandler?.()
    }

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'downloaded', version: '1.0.61' })
      )
    })

    quitAndInstall()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })
    expect(killAllPtyMock).toHaveBeenCalledTimes(1)
    expect(isQuittingForUpdate()).toBe(true)

    sendMock.mockClear()
    autoUpdaterMock.emit('error', new Error('late post-commit install error'))

    expect(isQuittingForUpdate()).toBe(true)
    // Why: handoff still owns the process after commit — no recovery message or check/download error status.
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('arms the forced-exit watchdog once the install commits', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, checkForUpdatesFromMenu, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.0.61',
        changelog: null
      })
    })

    autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })
    // Why: on macOS install commits only once Squirrel is ready; mark it ready so this test covers the committed path on all platforms.
    if (process.platform === 'darwin') {
      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      expect(nativeDownloadedHandler).toBeTypeOf('function')
      nativeDownloadedHandler?.()
    }

    expect(armExitWatchdogMock).not.toHaveBeenCalled()

    quitAndInstall()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    // Why: the installer (ShipIt/NSIS) waits for this process to exit; the watchdog prevents a wedged async shutdown from stranding the update.
    expect(armExitWatchdogMock).toHaveBeenCalledTimes(1)
  })

  it('disarms the forced-exit watchdog when sync install error recovery keeps the app open', async () => {
    vi.useFakeTimers()

    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      autoUpdaterMock.emit(
        'error',
        new Error("No update filepath provided, can't quit and install")
      )
    })

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(isQuittingForUpdate()).toBe(false)
    // Why: recovery leaves the app running; a live watchdog would force-exit a healthy session 20s later.
    expect(armExitWatchdogMock).not.toHaveBeenCalled()
    expect(disarmExitWatchdogMock).toHaveBeenCalled()
  })

  it('does not treat pre-native autoUpdater errors as quitAndInstall recovery', async () => {
    vi.useFakeTimers()

    let finishCleanup!: () => void
    const onBeforeQuit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      onBeforeQuit,
      getLastUpdateCheckAt: () => Date.now()
    })
    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(isQuittingForUpdate()).toBe(true)

    sendMock.mockClear()
    // Why: unrelated error during pre-quit cleanup must not clear quittingForUpdate or emit install-recovery status (native not invoked).
    autoUpdaterMock.emit('error', new Error('pre-native concurrent error'))

    expect(isQuittingForUpdate()).toBe(true)
    expect(sendMock).not.toHaveBeenCalled()

    finishCleanup()
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(isQuittingForUpdate()).toBe(true)
  })
})
