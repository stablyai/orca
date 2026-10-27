import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'
import { updaterMainWindow } from './updater-test-main-window'

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
vi.mock('./ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
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

  it('does not leak a nudge marker into a later ordinary update cycle', async () => {
    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    // Defer startup checks so they cannot block the nudge check.
    setupAutoUpdater(mainWindow, {
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
    const mainWindow = updaterMainWindow(sendMock)

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, {
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
    const mainWindow = updaterMainWindow(sendMock)

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return new Promise(() => {})
    })

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('respects the activation/resume cooldown for nudge checks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-12T12:00:00Z'))

    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow)

    await vi.advanceTimersByTimeAsync(0)

    fetchNudgeMock.mockClear()
    appMock.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchNudgeMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    appMock.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchNudgeMock).toHaveBeenCalledTimes(1)
  })

  it('clears pending nudge campaign when the follow-up check ends in not-available', async () => {
    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => null,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')

    autoUpdaterMock.emit('update-not-available')

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
  })

  it('clears pending nudge campaign when a silent follow-up check settles not-available', async () => {
    vi.useFakeTimers()
    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)
    let pendingNudgeId: string | null = null
    const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
      pendingNudgeId = id
    })
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, {
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
    const mainWindow = updaterMainWindow(sendMock)
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => null,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')

    autoUpdaterMock.emit('error', new Error('network timeout'))

    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
  })

  it('does not preserve a pending nudge for ordinary manifest transition errors', async () => {
    const sendMock = vi.fn()
    const mainWindow = updaterMainWindow(sendMock)
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

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, {
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
    const mainWindow = updaterMainWindow(sendMock)
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, dismissNudge } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => 'campaign-1',
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    dismissNudge()

    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
  })
})
