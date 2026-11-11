import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { updaterMainWindow } from './testing/updater-test-main-window'

const {
  autoUpdaterMock,
  fetchNewerReleaseTagsMock,
  powerMonitorOnMock,
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
vi.mock('../local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('../local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

warmUpdaterModule()

describe('fork auto-update switch', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    vi.stubEnv('DEV', false)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('makes no update check against the release feed in a packaged fork build', async () => {
    const send = vi.fn()
    const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu, getUpdateStatus } =
      await loadUpdaterModule()

    setupAutoUpdater(updaterMainWindow(send), { getLastUpdateCheckAt: () => null })
    checkForUpdates()
    checkForUpdatesFromMenu()
    checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.0.60' })
    await vi.dynamicImportSettled()

    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(fetchNewerReleaseTagsMock).not.toHaveBeenCalled()
    expect(powerMonitorOnMock).not.toHaveBeenCalled()
    expect(getUpdateStatus()).toEqual({ state: 'not-available', userInitiated: true })
  })
})
