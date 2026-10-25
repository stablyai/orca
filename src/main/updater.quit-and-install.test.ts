import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PRE_COMMIT_INSTALL_FAILURE } from './updater-test-harness'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'
import { updaterMainWindow } from './updater-test-main-window'

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
vi.mock('./ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
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

warmUpdaterModule()

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

    const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } = await loadUpdaterModule()

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

    const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } = await loadUpdaterModule()

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
    const { setupAutoUpdater, quitAndInstall } = await loadUpdaterModule()

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
    const { setupAutoUpdater, quitAndInstall } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { onBeforeQuit })
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(killAllPtyMock).toHaveBeenCalledTimes(1)
    expect(onBeforeQuit.mock.invocationCallOrder[0]).toBeLessThan(
      killAllPtyMock.mock.invocationCallOrder[0]
    )
  })

  it('aborts native install when required pre-quit cleanup fails', async () => {
    vi.useFakeTimers()

    const onBeforeQuit = vi.fn().mockRejectedValue(new Error('profile state export failed'))
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      onBeforeQuit,
      onBeforeQuitFailure: 'abort'
    })
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(killAllPtyMock).not.toHaveBeenCalled()
    expect(isQuittingForUpdate()).toBe(false)
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({
        state: 'error',
        message: expect.stringContaining('Could not restart to install the update')
      })
    )
  })

  it('keeps optional pre-quit cleanup fail-and-continue behavior by default', async () => {
    vi.useFakeTimers()

    const onBeforeQuit = vi.fn().mockRejectedValue(new Error('optional cleanup failed'))
    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { onBeforeQuit })
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(killAllPtyMock).toHaveBeenCalledTimes(1)
  })

  it('allows a required profile export to finish beyond the optional cleanup budget', async () => {
    vi.useFakeTimers()
    const onBeforeQuit = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 5_000)))
    const { setupAutoUpdater, quitAndInstall } = await loadUpdaterModule()
    setupAutoUpdater(updaterMainWindow(vi.fn()), { onBeforeQuit, onBeforeQuitFailure: 'abort' })
    quitAndInstall()
    await vi.advanceTimersByTimeAsync(2_600)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('aborts native install when required pre-quit cleanup times out', async () => {
    vi.useFakeTimers()

    const onBeforeQuit = vi.fn(() => new Promise<void>(() => {}))
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      onBeforeQuit,
      onBeforeQuitFailure: 'abort'
    })
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(90_000)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(killAllPtyMock).not.toHaveBeenCalled()
    expect(isQuittingForUpdate()).toBe(false)
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({
        state: 'error',
        message: expect.stringContaining('Could not restart to install the update')
      })
    )
  })

  it('ignores duplicate quitAndInstall requests while the shared delay is pending', async () => {
    vi.useFakeTimers()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await loadUpdaterModule()

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
    const { setupAutoUpdater, quitAndInstall } = await loadUpdaterModule()

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
      // BaseUpdater dispatches missing-file errors synchronously inside install.
      autoUpdaterMock.emit(
        'error',
        new Error("No update filepath provided, can't quit and install")
      )
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(isQuittingForUpdate()).toBe(false)
    expect(killAllPtyMock).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({
        state: 'error',
        // Preserve the native cause; restart advice is useful only where quitting re-stages the update.
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
      await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.0.61',
        changelog: null
      })
    })

    autoUpdaterMock.emit('download-progress', { percent: 100 })
    autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

    // Native Squirrel readiness is required to reach the committed path on macOS.
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

    const { setupAutoUpdater, checkForUpdatesFromMenu, quitAndInstall } = await loadUpdaterModule()

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
    // Native Squirrel readiness is required to reach the committed path on macOS.
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
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(isQuittingForUpdate()).toBe(false)
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
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await loadUpdaterModule()

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
    autoUpdaterMock.emit('error', new Error('pre-native concurrent error'))

    expect(isQuittingForUpdate()).toBe(true)
    expect(sendMock).not.toHaveBeenCalled()

    finishCleanup()
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(isQuittingForUpdate()).toBe(true)
  })
})
