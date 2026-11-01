import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UpdaterModule from './updater'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'
import { updaterMainWindow } from './updater-test-main-window'
import type { LinuxRootPackageType, UpdateStatus } from '../shared/update-status-types'

const {
  autoUpdaterMock,
  getLinuxRootPackageTypeMock,
  isExternallyManagedLinuxInstallMock,
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

const EXTERNALLY_MANAGED_MESSAGE =
  'This copy of Orca is managed by your system package manager, so Orca cannot install updates itself. Update Orca through your distribution instead.'

// Repackaged installs can retain the deb marker without a usable package manager.
warmUpdaterModule()

describe('updater externally managed Linux installs', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  async function startUpdater(options: {
    packageType: LinuxRootPackageType | null
    externallyManaged: boolean
  }): Promise<{ send: ReturnType<typeof vi.fn>; updater: typeof UpdaterModule }> {
    getLinuxRootPackageTypeMock.mockReturnValue(options.packageType)
    isExternallyManagedLinuxInstallMock.mockReturnValue(options.externallyManaged)
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
      return Promise.resolve(undefined)
    })
    const send = vi.fn()
    const updater = await loadUpdaterModule()
    updater.setupAutoUpdater(updaterMainWindow(send), {
      getLastUpdateCheckAt: () => Date.now(),
      installMode: 'interactive'
    })
    return { send, updater }
  }

  function lastStatus(send: ReturnType<typeof vi.fn>): UpdateStatus | undefined {
    return send.mock.calls.findLast(([channel]) => channel === 'updater:status')?.[1]
  }

  it('refuses the download instead of spending it on a package it can never install', async () => {
    const { send, updater } = await startUpdater({ packageType: 'deb', externallyManaged: true })
    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)

    updater.downloadUpdate()
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
    expect(lastStatus(send)).toEqual({
      state: 'error',
      message: EXTERNALLY_MANAGED_MESSAGE,
      messageCode: 'linuxPackageExternallyManaged',
      version: '1.0.61',
      retryable: false
    })
  })

  it('leaves an ordinary deb host able to download', async () => {
    const { updater } = await startUpdater({ packageType: 'deb', externallyManaged: false })
    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    autoUpdaterMock.downloadUpdate.mockResolvedValue([])

    updater.downloadUpdate()
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalled()
  })
})
