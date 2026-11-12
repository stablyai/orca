import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import type { UpdateStatus } from '../../shared/update-status-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { updaterMainWindow } from './testing/updater-test-main-window'

const {
  autoUpdaterMock,
  fetchChangelogMock,
  fetchNewerReleaseTagsMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () =>
  (await import('./testing/updater-test-harness')).createUpdaterMocks()
)

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('../ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
vi.mock('./linux-package/linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./releases/updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./nudges/nudge-campaign', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./releases/updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./releases/updater-release-readiness', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReleaseDownloadUrl: (
    await vi.importMock<{
      getReleaseDownloadUrl: typeof getReleaseDownloadUrl
    }>('./releases/updater-prerelease-feed')
  ).getReleaseDownloadUrl
}))
vi.mock('../local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('../local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

warmUpdaterModule()

describe('updater', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  it.each(['live', 'throwing'] as const)(
    'delivers forced failure before a queued modifier check despite %s delivery',
    async (delivery) => {
      vi.useFakeTimers()
      let settling = false
      const send = vi.fn(() => {
        if (settling && delivery === 'throwing') {
          throw new Error('Render frame was disposed')
        }
      })
      const window = updaterMainWindow(send)
      const { UpdaterSetup } = await import('./lifecycle/updater-setup')
      const failure: UpdateStatus = { state: 'error', message: 'Install preparation failed' }
      class TestUpdater extends UpdaterSetup {
        failInstall(): void {
          this.sendInstallFailureStatus(failure)
        }
      }
      const updater = new TestUpdater()
      let finishCheck = () => {}
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        return new Promise<void>((resolve) => {
          finishCheck = resolve
        })
      })
      updater.setupAutoUpdater(window, { getLastUpdateCheckAt: () => Date.now() })
      updater.checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledOnce()
      updater.checkForUpdatesFromMenu({ includePrerelease: true })
      settling = true
      send.mockClear()
      fetchNewerReleaseTagsMock.mockResolvedValue(['v1.0.52-rc.1'])

      expect(() => updater.failInstall()).not.toThrow()
      expect(updater.getUpdateStatus()).toEqual(failure)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledOnce()
      finishCheck()
      await vi.advanceTimersByTimeAsync(0)

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.allowPrerelease).toBe(true)
      expect(updater.getUpdateStatus()).toMatchObject({ state: 'checking' })
      expect(send).toHaveBeenNthCalledWith(1, 'updater:status', failure)
      expect(send).toHaveBeenNthCalledWith(
        2,
        'updater:status',
        expect.objectContaining({ state: 'checking' })
      )
      settling = false
      autoUpdaterMock.emit('update-not-available')
      finishCheck()
      await vi.advanceTimersByTimeAsync(0)
      expect(updater.getUpdateStatus()).toMatchObject({ state: 'not-available' })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    }
  )

  it('delivers to the successor after its initial pull, before its updater setup', async () => {
    const oldSend = vi.fn()
    const newSend = vi.fn()
    const oldWindow = updaterMainWindow(oldSend)
    const successor = updaterMainWindow(newSend)
    let currentWindow: typeof oldWindow | null = oldWindow
    const updater = await loadUpdaterModule()
    updater.setupAutoUpdater(oldWindow, {
      getMainWindow: () => currentWindow,
      getLastUpdateCheckAt: () => Date.now()
    })
    currentWindow = null
    autoUpdaterMock.emit('download-progress', { percent: 40 })
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloading', percent: 40 })
    expect(oldSend).not.toHaveBeenCalled()

    currentWindow = successor
    expect(updater.getUpdateStatus()).toMatchObject({ percent: 40 })
    autoUpdaterMock.emit('download-progress', { percent: 60 })
    expect(newSend).toHaveBeenCalledExactlyOnceWith(
      'updater:status',
      expect.objectContaining({ percent: 60 })
    )
    expect(oldSend).not.toHaveBeenCalled()
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
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, { getLastUpdateCheckAt: () => Date.now() })
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
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, { getLastUpdateCheckAt: () => null })
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
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, { getLastUpdateCheckAt: () => null })

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
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, {
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
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, {
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
    const mainWindow = updaterMainWindow(sendMock)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow, { getLastUpdateCheckAt: () => Date.now() })
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
