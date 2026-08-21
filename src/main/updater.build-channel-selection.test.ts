import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appMock,
  autoUpdaterMock,
  fetchNewerReleaseTagsMock,
  chooseLocalBuildMock,
  closeLocalBuildFeedMock,
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

/** Mirrors AUTO_UPDATE_CHECK_INTERVAL_MS in updater.ts. */
const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

describe('updater', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  it.each([
    [
      'hourly',
      'v1.4.160-hourly.202607281400',
      'Hourly builds are produced only for macOS and Windows.'
    ],
    [
      'daily',
      'v1.4.160-daily.202607281300',
      'Daily builds are produced only for macOS and Windows.'
    ],
    [
      'adhoc',
      'v1.4.160-adhoc.20260728140533',
      'Adhoc builds are produced only for macOS and Windows.'
    ]
  ] as const)(
    'uses the display label in the unsupported-platform %s pinned-build error',
    async (channel, tag, message) => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      try {
        const send = vi.fn()
        const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')
        setupAutoUpdater({ webContents: { send } } as never, {
          getLastUpdateCheckAt: () => Date.now()
        })

        checkForUpdatesFromMenu({ channel, targetTag: tag })

        expect(send).toHaveBeenCalledWith('updater:status', {
          state: 'error',
          message,
          userInitiated: true
        })
        expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
      } finally {
        platformSpy.mockRestore()
      }
    }
  )

  // Why this refuses rather than trying: electron-updater would download the
  // whole installer and then fail it with a raw ERR_UPDATER_INVALID_SIGNATURE,
  // because a signed build verifies every installer against the publisherName
  // baked into its own app-update.yml. The picker disables this, but IPC is
  // reachable regardless.
  it('refuses to pin a Windows dev build from a signed build, and says what to do', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      appMock.getVersion.mockReturnValue('1.4.160')
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ channel: 'adhoc', targetTag: 'v1.4.160-adhoc.20260728140533' })

      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: expect.stringContaining('Download the installer from the release page'),
        userInitiated: true
      })
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
    }
  })

  // The way out of a dev channel must stay in-app: an unsigned build carries no
  // publisherName, so electron-updater skips verification entirely.
  it.each([
    ['another dev build', 'adhoc', 'v1.4.160-adhoc.20260728140533'],
    ['back to stable', 'stable', 'v1.4.160']
  ] as const)(
    'still pins %s from an unsigned Windows dev build',
    async (_label, channel, targetTag) => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      try {
        appMock.getVersion.mockReturnValue('1.4.160-hourly.202607281400')
        const send = vi.fn()
        const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')
        setupAutoUpdater({ webContents: { send } } as never, {
          getLastUpdateCheckAt: () => Date.now()
        })

        checkForUpdatesFromMenu({ channel, targetTag })

        expect(send).not.toHaveBeenCalledWith('updater:status', {
          state: 'error',
          message: expect.stringContaining('Download the installer'),
          userInitiated: true
        })
        expect(autoUpdaterMock.allowDowngrade).toBe(true)
      } finally {
        platformSpy.mockRestore()
      }
    }
  )

  it.runIf(process.platform === 'darwin')(
    'allows a validated local build to downgrade through the normal updater lifecycle',
    async () => {
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-available', { version: '0.9.0-local.1' })
        return Promise.resolve(undefined)
      })
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })

      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(autoUpdaterMock.allowDowngrade).toBe(true)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(true)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'http://127.0.0.1:1234/token/'
      })
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({
            state: 'available',
            version: '0.9.0-local.1',
            source: 'local'
          })
        )
      })

      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'http://127.0.0.1:1234/token/'
      })
      expect(autoUpdaterMock.allowDowngrade).toBe(true)

      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      checkForUpdatesFromMenu()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      })
      expect(closeLocalBuildFeedMock).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.allowDowngrade).toBe(false)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(false)
    }
  )

  it.runIf(process.platform === 'darwin')(
    'restores ordinary release checks after local build selection fails',
    async () => {
      chooseLocalBuildMock.mockRejectedValue(new Error('invalid local build'))
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith('updater:status', {
          state: 'error',
          message: 'invalid local build',
          userInitiated: true,
          source: 'local'
        })
      })

      checkForUpdates()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(autoUpdaterMock.allowDowngrade).toBe(false)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(false)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'restores ordinary release checks after a local build is unavailable',
    async () => {
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-not-available')
        return Promise.resolve(undefined)
      })
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.waitFor(() => {
        expect(closeLocalBuildFeedMock).toHaveBeenCalledTimes(1)
      })
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'not-available',
        userInitiated: true,
        source: 'local'
      })
      expect(autoUpdaterMock.allowDowngrade).toBe(false)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(false)

      checkForUpdates()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'restores ordinary release checks after a local updater failure',
    async () => {
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockRejectedValueOnce(new Error('local feed failed'))
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith('updater:status', {
          state: 'error',
          message: 'local feed failed',
          userInitiated: true,
          source: 'local'
        })
      })
      expect(closeLocalBuildFeedMock).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.allowDowngrade).toBe(false)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(false)

      checkForUpdates()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'keeps the automatic check chain alive across a local build session',
    async () => {
      vi.useFakeTimers()
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-available', { version: '0.9.0-local.1' })
        return Promise.resolve(undefined)
      })
      autoUpdaterMock.downloadUpdate.mockRejectedValue(new Error('local download failed'))
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'available', source: 'local' })
      )

      // Why: assert through this window rather than the shared updater mock — a status only lands here
      // when this module instance owns the check attempt, so sibling tests' timers can't fake a pass.
      autoUpdaterMock.checkForUpdates.mockReset().mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-not-available')
        return Promise.resolve(undefined)
      })

      // The scheduled release check fires while the local session still owns the feed, so it defers.
      send.mockClear()
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_CHECK_INTERVAL_MS)
      expect(send).not.toHaveBeenCalledWith('updater:status', { state: 'not-available' })

      // A failed local download ends the session and restores the release source.
      downloadUpdate()
      await vi.advanceTimersByTimeAsync(0)
      expect(autoUpdaterMock.allowDowngrade).toBe(false)

      send.mockClear()
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_CHECK_INTERVAL_MS)
      expect(send).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'restores release checks when an offered local build is dismissed',
    async () => {
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-available', { version: '0.9.0-local.1' })
        return Promise.resolve(undefined)
      })
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu, dismissAvailableUpdate } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({ state: 'available', source: 'local' })
        )
      })

      dismissAvailableUpdate()
      expect(closeLocalBuildFeedMock).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.allowDowngrade).toBe(false)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(false)
      expect(send).toHaveBeenCalledWith('updater:status', { state: 'idle' })

      autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(undefined)
      checkForUpdates()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'keeps the local feed in force when a dismiss lands during a local build download',
    async () => {
      chooseLocalBuildMock.mockResolvedValue({
        version: '0.9.0-local.1',
        manifestContent: 'version: 0.9.0-local.1',
        artifacts: new Map()
      })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-available', { version: '0.9.0-local.1' })
        return Promise.resolve(undefined)
      })
      autoUpdaterMock.downloadUpdate.mockResolvedValue(undefined)
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu, dismissAvailableUpdate, downloadUpdate } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ localBuild: true })
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({ state: 'available', source: 'local' })
        )
      })

      downloadUpdate()
      dismissAvailableUpdate()

      expect(closeLocalBuildFeedMock).not.toHaveBeenCalled()
      expect(autoUpdaterMock.allowDowngrade).toBe(true)
      expect(autoUpdaterMock.disableDifferentialDownload).toBe(true)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'http://127.0.0.1:1234/token/'
      })
    }
  )

  it('opts into the RC channel when checkForUpdatesFromMenu is called with includePrerelease', async () => {
    appMock.getVersion.mockReturnValue('1.3.17')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.18-rc.1'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    // Why: recent timestamp defers the startup check so we observe updater state before any RC-mode call, without racing.
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const setupFeedUrlCalls = autoUpdaterMock.setFeedURL.mock.calls.length
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)

    checkForUpdatesFromMenu({ includePrerelease: true })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17', 2, {
        includePrerelease: true
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.18-rc.1'
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
    expect(autoUpdaterMock.setFeedURL.mock.calls.length).toBe(setupFeedUrlCalls + 1)
  })

  it('pins the generic feed to a perf-tagged prerelease when requested', async () => {
    appMock.getVersion.mockReturnValue('1.4.120')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.4.121-rc.6.perf'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu({ includePerfPrerelease: true })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.120', 2, {
        includePrerelease: true,
        releaseFilter: 'perf'
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.4.121-rc.6.perf'
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
  })

  it('surfaces no-update feedback when no newer perf-tagged prerelease exists', async () => {
    appMock.getVersion.mockReturnValue('1.4.120')
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const setupFeedUrlCalls = autoUpdaterMock.setFeedURL.mock.calls.length

    checkForUpdatesFromMenu({ includePerfPrerelease: true })

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'not-available',
        userInitiated: true
      })
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.120', 2, {
      includePrerelease: true,
      releaseFilter: 'perf'
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdaterMock.setFeedURL.mock.calls.length).toBe(setupFeedUrlCalls)
  })

  it('keeps background retries on the stable channel after a perf publishing-window miss', async () => {
    vi.useFakeTimers()
    appMock.getVersion.mockReturnValue('1.4.120')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'not-ready' })
      .mockResolvedValueOnce(['v1.4.121'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu({ includePerfPrerelease: true })

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenNthCalledWith(2, '1.4.120', 1, {
        includePrerelease: false
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.4.121'
      })
    })
  })

  it('keeps prerelease publishing-window misses on the generic retry path', async () => {
    appMock.getVersion.mockReturnValue('1.4.120-rc.5')
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'not-ready' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu({ includePrerelease: true })

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.120-rc.5', 2, {
      includePrerelease: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('leaves the feed URL alone for a normal user-initiated check', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const initialFeedUrlCalls = autoUpdaterMock.setFeedURL.mock.calls.length

    checkForUpdatesFromMenu()
    checkForUpdatesFromMenu({ includePrerelease: false })

    expect(autoUpdaterMock.setFeedURL.mock.calls.length).toBe(initialFeedUrlCalls)
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)
  })
})
