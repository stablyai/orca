import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const { appMock, autoUpdaterMock, fetchNewerReleaseTagsMock, moduleFactories, resetUpdaterMocks } =
  await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

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

warmUpdaterModule()

describe('updater', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  it('retries a prerelease check once against the previous feed tag when the manifest is missing', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return Promise.reject(missingManifest)
      }
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-not-available')
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.51-rc.7'
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.51-rc.6'
      })
    })

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))
  })

  it('surfaces a promise-only prerelease fallback failure after the primary error event', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      return Promise.reject(missingManifest)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
  })

  it('allows the short background retry to launch after a promise-only prerelease fallback failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      if (callCount === 1) {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        return Promise.reject(missingManifest)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'idle' })
    })

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('does not let user-initiated promise-only fallback failures taint the next background check', async () => {
    let lastUpdateCheckAt = Date.now()
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      if (callCount === 1) {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        return Promise.reject(missingManifest)
      }
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-not-available')
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => lastUpdateCheckAt })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })

    sendMock.mockClear()
    lastUpdateCheckAt = Date.now() - 25 * 60 * 60 * 1000
    appMock.emit('browser-window-focus')

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'not-available' })
      expect(statuses).not.toContainEqual({ state: 'checking', userInitiated: true })
      expect(statuses).not.toContainEqual({ state: 'not-available', userInitiated: true })
    })
  })

  it('preserves user-initiated state for delayed prerelease fallback not-available', async () => {
    vi.useFakeTimers()
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      if (callCount === 1) {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return Promise.reject(missingManifest)
      }
      setTimeout(() => {
        autoUpdaterMock.emit('update-not-available')
      }, 10)
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    await vi.advanceTimersByTimeAsync(10)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
  })

  it('ignores a delayed primary error after a promise-launched prerelease fallback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        setTimeout(() => {
          autoUpdaterMock.emit('error', missingManifest)
        }, 10)
        return Promise.reject(missingManifest)
      }
      if (callCount === 2) {
        setTimeout(() => {
          autoUpdaterMock.emit('update-not-available')
        }, 20)
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    await vi.advanceTimersByTimeAsync(30)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statuses).toContainEqual({ state: 'not-available' })
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('handles an event-only fallback error after a promise-only primary failure', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifestMessage =
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    const primaryMissingManifest = new Error(missingManifestMessage)
    const fallbackMissingManifest = new Error(missingManifestMessage)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        return Promise.reject(primaryMissingManifest)
      }
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', fallbackMissingManifest)
      })
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses.at(-1)).toEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
  })

  it('suppresses a delayed background fallback error after the fallback promise handled it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        setTimeout(() => {
          autoUpdaterMock.emit('error', missingManifest)
        }, 10)
        return Promise.reject(missingManifest)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'idle' })
    })

    sendMock.mockClear()
    await vi.advanceTimersByTimeAsync(10)

    const statusesAfterLateError = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statusesAfterLateError).not.toContainEqual(
      expect.objectContaining({ state: 'error', message: missingManifest.message })
    )

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('suppresses a delayed user fallback error after the fallback promise handled it', async () => {
    vi.useFakeTimers()
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      setTimeout(() => {
        autoUpdaterMock.emit('error', missingManifest)
      }, 10)
      return Promise.reject(missingManifest)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })

    sendMock.mockClear()
    await vi.advanceTimersByTimeAsync(10)

    const statusesAfterLateError = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statusesAfterLateError).not.toContainEqual(
      expect.objectContaining({ state: 'error', message: missingManifest.message })
    )
  })

  it('keeps background prerelease fallback not-available on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 2) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'not-available' })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('keeps user prerelease fallback not-available on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setLastUpdateCheckAt
    })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('keeps user prerelease fallback available on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.5')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-available', { version: '1.3.51-rc.6' })
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setLastUpdateCheckAt
    })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'available',
        version: '1.3.51-rc.6',
        changelog: null
      })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('surfaces the failure when the bounded prerelease fallback also misses its manifest', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', missingManifest)
      })
      return Promise.reject(missingManifest)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
  })

  // Why: /releases/latest/download is a moving redirect; a relative ZIP URL from an old manifest can resolve against a newer release and 404.
  it('pins the generic feed to a concrete stable tag for a stable user', async () => {
    appMock.getVersion.mockReturnValue('1.3.17')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.18'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17', 1, {
        includePrerelease: false
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.3.18'
    })
  })

  // Why: native GitHub provider can pick cancelled prerelease tags with missing manifests, so keep the manifest-probed generic feed.
  it('uses the manifest-probed generic feed after a Shift-click RC opt-in', async () => {
    appMock.getVersion.mockReturnValue('1.3.17')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.18-rc.1'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu({ includePrerelease: true })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17', 2, {
        includePrerelease: true
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.3.18-rc.1'
    })
  })
})
