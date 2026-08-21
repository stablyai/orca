import { beforeEach, describe, expect, it, vi } from 'vitest'

const { autoUpdaterMock, moduleFactories, resetUpdaterMocks } = await vi.hoisted(async () =>
  (await import('./updater-test-harness')).createUpdaterMocks()
)

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

describe('updater silent-settle delay injection', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  it('honors an injected silent-settle delay instead of the 1s default', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    // Resolve with no terminal event: the unstick path the grace timer exists for.
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn(),
      // Why: must stay under the 45s stall timeout, which would otherwise settle the attempt first.
      silentSettleDelayMs: 30_000
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    // Past the 1s default but short of the injected delay: must not settle yet.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'not-available' })
    )

    await vi.advanceTimersByTimeAsync(15_000)
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'not-available' })
    )
  })
})
