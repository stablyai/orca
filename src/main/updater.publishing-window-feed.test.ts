import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

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

warmUpdaterModule()

describe('updater', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  // Why: native github provider + allowPrerelease traps RC users on the RC channel, so resolve the newest tag ourselves and pin the generic feed to it.
  it('repins the generic feed to the newest RC tag for a prerelease user', async () => {
    appMock.getVersion.mockReturnValue('1.3.17-rc.1')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.17-rc.2'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    // Setup pins the default generic feed; resolver only runs per check.
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    })
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17-rc.1', 2, {
        includePrerelease: true
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.17-rc.2'
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
  })

  // Why: RC users couldn't upgrade to newer stable (PR #1053); resolver must pick the stable tag for a prerelease user.
  it('repins the generic feed to a newer stable tag for a prerelease user', async () => {
    appMock.getVersion.mockReturnValue('1.3.19-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.19'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.19'
      })
    })
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)
  })

  // Why: if the atom resolver fails or finds nothing newer, fall back to /releases/latest/download so the check completes as "not-available" instead of erroring.
  it('falls back to /releases/latest/download when the atom resolver returns null', async () => {
    appMock.getVersion.mockReturnValue('1.3.19-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue([])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    })
  })

  it('keeps unavailable release probes on generic copy without launching a moving feed', async () => {
    appMock.getVersion.mockReturnValue('1.4.141')
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'unavailable',
      unavailableReason: 'manifest'
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const feedCallsBeforeCheck = autoUpdaterMock.setFeedURL.mock.calls.length
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdaterMock.setFeedURL.mock.calls.slice(feedCallsBeforeCheck)).not.toContainEqual([
      {
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      }
    ])
  })

  it('keeps Atom feed outages on the existing moving-feed fallback', async () => {
    appMock.getVersion.mockReturnValue('1.4.141')
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'unavailable',
      unavailableReason: 'feed'
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    })
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error' })
    )
  })

  it('uses last-good concrete feed when a user-initiated check lands during publishing', async () => {
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.26'
    })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-not-available')
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const feedCallsBeforeCheck = autoUpdaterMock.setFeedURL.mock.calls.length
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'checking', userInitiated: true })
      expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
    })
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.26'
    })
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
    expect(autoUpdaterMock.setFeedURL.mock.calls.slice(feedCallsBeforeCheck)).not.toContainEqual([
      {
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      }
    ])
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error' })
    )
  })

  it('can offer an older fully published update while the newest release is publishing', async () => {
    appMock.getVersion.mockReturnValue('1.4.25')
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.26'
    })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.4.26' })
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.4.26',
        changelog: null
      })
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.26'
    })
  })

  it('keeps background publishing-window fallback on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return new Promise(() => {})
    })
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.26'
    })
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    autoUpdaterMock.emit('update-not-available')

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
    })
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
  })

  it('keeps silent publishing-window fallback on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'not-available' })
    )
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
  })

  it('keeps background checks retryable while newer release assets are still publishing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'not-ready' })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(1)
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.26', 1, {
      includePrerelease: false
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
  })

  it.each([
    {
      caseName: 'stable-not-ready',
      version: '1.4.26',
      candidateLimit: 1,
      includePrerelease: false,
      result: { tags: [], state: 'not-ready' as const }
    },
    {
      caseName: 'prerelease-not-ready',
      version: '1.4.26-rc.1',
      candidateLimit: 2,
      includePrerelease: true,
      result: { tags: [], state: 'not-ready' as const }
    },
    {
      caseName: 'stable-manifest-unavailable',
      version: '1.4.26',
      candidateLimit: 1,
      includePrerelease: false,
      result: { tags: [], state: 'unavailable' as const, unavailableReason: 'manifest' as const }
    }
  ])(
    'keeps a nudge campaign pending for $caseName',
    async ({ version, candidateLimit, includePrerelease, result }) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
      appMock.getVersion.mockReturnValue(version)
      fetchNudgeMock.mockResolvedValueOnce({ id: 'campaign-1', minVersion: '1.0.0' })
      fetchNudgeMock.mockResolvedValue(null)
      shouldApplyNudgeMock.mockReturnValue(true)
      fetchNewerReleaseTagsMock
        .mockResolvedValueOnce(result)
        .mockResolvedValueOnce({ tags: ['v1.4.27'], state: 'ready' })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        return Promise.resolve(undefined)
      })
      let pendingNudgeId: string | null = null
      const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
        pendingNudgeId = id
      })
      const setDismissedUpdateNudgeId = vi.fn()
      const sendMock = vi.fn()
      const mainWindow = { webContents: { send: sendMock } }

      const { setupAutoUpdater } = await loadUpdaterModule()

      setupAutoUpdater(mainWindow as never, {
        getLastUpdateCheckAt: () => Date.now(),
        getPendingUpdateNudgeId: () => pendingNudgeId,
        getDismissedUpdateNudgeId: () => null,
        setPendingUpdateNudgeId,
        setDismissedUpdateNudgeId
      })

      await vi.waitFor(() => {
        expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(1)
      })
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith(version, candidateLimit, {
        includePrerelease
      })
      expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
      expect(setPendingUpdateNudgeId).not.toHaveBeenCalledWith(null)
      expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
      expect(pendingNudgeId).toBe('campaign-1')

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      autoUpdaterMock.emit('update-available', { version: '1.4.27' })
      await vi.advanceTimersByTimeAsync(0)

      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.4.27',
        changelog: null,
        activeNudgeId: 'campaign-1'
      })
      expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
    }
  )

  it('does not dismiss a nudge when last-good fallback is current during publishing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
      }
      return Promise.resolve(undefined)
    })
    let pendingNudgeId: string | null = null
    const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
      pendingNudgeId = id
    })
    const setDismissedUpdateNudgeId = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      getPendingUpdateNudgeId: () => pendingNudgeId,
      getDismissedUpdateNudgeId: () => null,
      setPendingUpdateNudgeId,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(sendMock).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
    })

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).not.toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
    expect(pendingNudgeId).toBe('campaign-1')

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    autoUpdaterMock.emit('update-available', { version: '1.4.27' })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.4.27',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })
  })

  it('does not attach nudge dismissal to an older last-good available update', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.25')
    fetchNudgeMock.mockResolvedValueOnce({ id: 'campaign-1', minVersion: '1.0.0' })
    fetchNudgeMock.mockResolvedValue(null)
    shouldApplyNudgeMock.mockReturnValue(true)
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-available', { version: '1.4.26' })
        })
      }
      return Promise.resolve(undefined)
    })
    let pendingNudgeId: string | null = null
    const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
      pendingNudgeId = id
    })
    const setDismissedUpdateNudgeId = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, dismissNudge } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      getPendingUpdateNudgeId: () => pendingNudgeId,
      getDismissedUpdateNudgeId: () => null,
      setPendingUpdateNudgeId,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.4.26',
        changelog: null
      })
    })
    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    const lastGoodStatus = statuses.find(
      (status) => status.state === 'available' && status.version === '1.4.26'
    )
    if (lastGoodStatus && 'activeNudgeId' in lastGoodStatus) {
      dismissNudge()
    }

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).not.toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
    expect(pendingNudgeId).toBe('campaign-1')

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    autoUpdaterMock.emit('update-available', { version: '1.4.27' })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.4.27',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })
  })
})
