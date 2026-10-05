import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const { appMock, autoUpdaterMock, chooseLocalBuildMock, moduleFactories, resetUpdaterMocks } =
  await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

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

describe('updater SQLite downgrade protection', () => {
  beforeEach(() => resetUpdaterMocks())
  it.each(['darwin', 'linux', 'win32'] as const)(
    'refuses a JSON-only pinned build on %s before configuring its feed',
    async (platform) => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      try {
        appMock.getVersion.mockReturnValue('1.4.221')
        const send = vi.fn()
        const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked updater only reads webContents.send from this window fixture.
        setupAutoUpdater({ webContents: { send } } as never, {
          getLastUpdateCheckAt: () => Date.now()
        })
        autoUpdaterMock.setFeedURL.mockClear()
        checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.213' })
        await vi.waitFor(() =>
          expect(send).toHaveBeenCalledWith('updater:status', {
            state: 'error',
            message: expect.stringContaining('predates SQLite'),
            userInitiated: true
          })
        )
        expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
        expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
      } finally {
        platformSpy.mockRestore()
      }
    }
  )

  it.runIf(process.platform === 'darwin')(
    'closes an incompatible local build before opening a feed',
    async () => {
      appMock.getVersion.mockReturnValue('1.4.221')
      const close = vi.fn().mockResolvedValue(undefined)
      chooseLocalBuildMock.mockResolvedValue({ version: '1.4.213', close })
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked updater only reads webContents.send from this window fixture.
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })
      checkForUpdatesFromMenu({ localBuild: true })
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({
            state: 'error',
            message: expect.stringContaining('predates SQLite')
          })
        )
      )
      expect(close).toHaveBeenCalledOnce()
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    }
  )
})
