import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const {
  autoUpdaterMock,
  fetchChangelogMock,
  fetchNewerReleaseTagsMock,
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

warmUpdaterModule()

describe('updater', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  it('leaves a dismissed release update on the release source', async () => {
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      autoUpdaterMock.emit('update-available', { version: '2.0.0' })
      return Promise.resolve(undefined)
    })
    const send = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu, dismissAvailableUpdate } =
      await loadUpdaterModule()
    setupAutoUpdater({ webContents: { send } } as never, {
      getLastUpdateCheckAt: () => Date.now()
    })

    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'available', version: '2.0.0' })
      )
    })

    dismissAvailableUpdate()

    // Why: a release dismissal is renderer-only state; main must not clear the offer it can still install.
    expect(closeLocalBuildFeedMock).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('updater:status', { state: 'idle' })
  })

  it('deduplicates identical check errors from the event and rejected promise', async () => {
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('boom'))
      })
      return Promise.reject(new Error('boom'))
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
      expect(statuses).toContainEqual({ state: 'error', message: 'boom', userInitiated: true })
    })

    const errorStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter((status) => typeof status === 'object' && status !== null && status.state === 'error')

    expect(errorStatuses).toEqual([{ state: 'error', message: 'boom', userInitiated: true }])
  })

  it('surfaces net::ERR_FAILED to user-initiated checks with a friendly message', async () => {
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
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
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining("Couldn't reach the update server")
        })
      )
    })

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual({ state: 'checking', userInitiated: true })
    // Why: the raw electron-updater message is replaced so we never surface "net::ERR_FAILED" to the UI.
    expect(statuses).not.toContainEqual(
      expect.objectContaining({ state: 'error', message: 'net::ERR_FAILED' })
    )
  })

  it('shows checking immediately for a user-initiated check while feed pinning is pending', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    const checkingStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter(
        (status) => typeof status === 'object' && status !== null && status.state === 'checking'
      )

    expect(checkingStatuses).toEqual([{ state: 'checking', userInitiated: true }])
  })

  it('keeps background checks event-driven before checking-for-update fires', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    expect(
      sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
        .some(
          (status) => typeof status === 'object' && status !== null && status.state === 'checking'
        )
    ).toBe(false)

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'checking' })
    )
  })

  it('promotes a pending background check to user-initiated without launching a duplicate check', async () => {
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

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('keeps a silent background settle user-initiated after menu promotion', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(0)

    sendMock.mockClear()
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('settles a manual check when electron-updater resolves without a terminal event', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
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
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
    expect(setLastUpdateCheckAt).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale update-available event after a silent background settle', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchChangelogMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.61' })
    )
  })

  it('ignores a stale checking-for-update event after a silent manual settle', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    autoUpdaterMock.emit('checking-for-update')

    expect(sendMock).not.toHaveBeenCalled()
  })
})
