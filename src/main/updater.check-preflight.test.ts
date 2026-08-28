import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appMock,
  autoUpdaterMock,
  fetchChangelogMock,
  fetchNewerReleaseTagsMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

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

describe('updater', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  it('ignores stale updater events while a new check is still in feed preflight', async () => {
    vi.useFakeTimers()
    let resolveSecondTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'no-newer' })
      .mockImplementationOnce(
        () =>
          new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
            resolveSecondTags = resolve
          })
      )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).not.toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })

    resolveSecondTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('does not let a stale silent settle finish a later manual check', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'not-available',
        userInitiated: true
      })
    })

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).not.toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('does not let a stale pending update-available block a later silent settle', async () => {
    vi.useFakeTimers()
    let resolveChangelog: (value: null) => void = () => {}
    fetchChangelogMock.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveChangelog = resolve
        })
    )
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.52'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-available', { version: '1.0.52' })
        })
      }
      return Promise.resolve(undefined)
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(fetchChangelogMock).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('error', new Error('boom'))
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'boom',
        userInitiated: undefined
      })
    })

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })

    sendMock.mockClear()
    resolveChangelog(null)
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.52' })
    )
  })

  it('ignores a stale update-available event after a new check starts preflight', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchChangelogMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.61' })
    )
  })

  it('ignores a stale update-not-available event after a new check starts preflight', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).not.toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('ignores a stale error event after a new check starts preflight', async () => {
    vi.useFakeTimers()
    let resolveSecondTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'no-newer' })
      .mockImplementationOnce(
        () =>
          new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
            resolveSecondTags = resolve
          })
      )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('error', new Error('stale boom'))

    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error', message: 'stale boom' })
    )

    resolveSecondTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('times out a manual preflight that never reaches electron-updater events', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockImplementation(() => new Promise(() => {}))
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    await vi.advanceTimersByTimeAsync(45 * 1000)

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'error',
      message: 'Update check timed out. Try again in a few minutes.',
      userInitiated: true
    })
  })

  it('does not launch electron-updater after a manual preflight timeout settles', async () => {
    vi.useFakeTimers()
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(45 * 1000)
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'error',
      message: 'Update check timed out. Try again in a few minutes.',
      userInitiated: true
    })

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('runs a fresh prerelease check when Shift-click promotes an in-flight stable check', async () => {
    vi.useFakeTimers()
    let resolveStableTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    let resolveStableCheck: () => void = () => {}
    fetchNewerReleaseTagsMock
      .mockImplementationOnce(
        () =>
          new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
            resolveStableTags = resolve
          })
      )
      .mockResolvedValueOnce({ tags: ['v1.4.36-rc.5'], state: 'ready' })
    autoUpdaterMock.checkForUpdates
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveStableCheck = resolve
          })
      )
      .mockResolvedValueOnce(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    appMock.getVersion.mockReturnValue('1.4.35')
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })
    checkForUpdatesFromMenu({ includePrerelease: true })

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    resolveStableTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')
    await vi.advanceTimersByTimeAsync(0)
    resolveStableCheck()

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.35', 2, {
        includePrerelease: true
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.36-rc.5'
    })
    expect(
      sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
    ).not.toContainEqual({ state: 'not-available', userInitiated: true })
  })

  it('keeps promoted background promise failures user-initiated after a paired error event', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })
    checkForUpdatesFromMenu()
    resolveTags({ tags: [], state: 'no-newer' })

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining("Couldn't reach the update server")
        })
      )
    })

    const resultStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter(
        (status) =>
          typeof status === 'object' &&
          status !== null &&
          (status.state === 'idle' || status.state === 'error')
      )

    expect(resultStatuses).toEqual([
      expect.objectContaining({
        state: 'error',
        userInitiated: true,
        message: expect.stringContaining("Couldn't reach the update server")
      })
    ])
  })

  it('deduplicates repeated manual checks while the immediate checking status is active', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    checkForUpdatesFromMenu()

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(1)
  })
})
