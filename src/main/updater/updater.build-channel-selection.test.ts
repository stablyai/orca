import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { updaterMainWindow } from './testing/updater-test-main-window'

const { appMock, autoUpdaterMock, moduleFactories, resetUpdaterMocks } = await vi.hoisted(
  async () => (await import('./testing/updater-test-harness')).createUpdaterMocks()
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
    vi.useFakeTimers({ now: 0 })
  })

  // Signed Windows builds verify publisherName; refuse unsigned dev jumps before downloading.
  it('refuses to pin a Windows dev build from a signed build, and says what to do', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      appMock.getVersion.mockReturnValue('1.4.160')
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
      setupAutoUpdater(updaterMainWindow(send), {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ channel: 'adhoc', targetTag: 'v1.4.160-adhoc.20260728140533' })

      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: expect.stringContaining('Download the installer from the release page'),
        messageCode: 'unsignedDevChannel',
        messageParams: { channel: 'Adhoc' },
        userInitiated: true
      })
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
    }
  })
})
