import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appMock,
  autoUpdaterMock,
  fetchNudgeMock,
  shouldApplyNudgeMock,
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

  it('does not leak a nudge marker into a later ordinary update cycle', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    // Why: recent timestamp defers the startup check so the nudge check runs without hitting the 'checking' guard.
    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.61',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })

    sendMock.mockClear()
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      const statusCalls = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)

      expect(statusCalls).toContainEqual({ state: 'checking', userInitiated: true })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })

    autoUpdaterMock.emit('update-available', { version: '1.0.62' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.62',
      changelog: null
    })
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ version: '1.0.62', activeNudgeId: 'campaign-1' })
    )
  })

  it('preserves the pending nudge marker across a later background check', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      getPendingUpdateNudgeId: () => 'campaign-1',
      getDismissedUpdateNudgeId: () => null
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.61',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })
  })

  it('does not trigger a nudge check while an updater check is already in progress', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      // Stay in 'checking' state — don't resolve
      return new Promise(() => {})
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    // Wait for the startup nudge check to run
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The 'checking' guard should block runBackgroundUpdateCheck while the startup check is in progress.
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('respects the activation/resume cooldown for nudge checks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-12T12:00:00Z'))

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never)

    // Wait for the startup nudge check to complete
    await vi.advanceTimersByTimeAsync(0)

    // Startup check set lastNudgeCheckAt, so browser-window-focus is blocked by the 5-minute cooldown.
    fetchNudgeMock.mockClear()
    appMock.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)

    // fetchNudge should NOT have been called again — cooldown blocks it
    expect(fetchNudgeMock).not.toHaveBeenCalled()

    // Advance past the cooldown
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    appMock.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchNudgeMock).toHaveBeenCalledTimes(1)
  })

  it('clears pending nudge campaign when the follow-up check ends in not-available', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => null,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    // Nudge was applied — pending id was set
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')

    // Now simulate the updater finding no update
    autoUpdaterMock.emit('update-not-available')

    // Pending cleared and campaign auto-dismissed so it doesn't re-fire next poll cycle.
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
  })

  it('clears pending nudge campaign when a silent follow-up check settles not-available', async () => {
    vi.useFakeTimers()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    let pendingNudgeId: string | null = null
    const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
      pendingNudgeId = id
    })
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => pendingNudgeId,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(pendingNudgeId).toBe(null)
  })

  it('auto-dismisses nudge campaign when the follow-up check errors out', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => null,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')

    // Simulate an error during the nudge-triggered check
    autoUpdaterMock.emit('error', new Error('network timeout'))

    // Campaign should be auto-dismissed to prevent re-fire loop
    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
  })

  it('does not preserve a pending nudge for ordinary manifest transition errors', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()
    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.reject(missingManifest)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => null,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
    })

    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
  })

  it('moves pending nudge to dismissed when dismissNudge is called', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, dismissNudge } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => 'campaign-1',
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    // Simulate update found, then user dismisses
    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    dismissNudge()

    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
  })
})
