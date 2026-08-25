import { beforeEach, describe, expect, it, vi } from 'vitest'

const { moduleFactories, resetUpdaterMocks } = await vi.hoisted(
  async () => (await import('./updater-test-harness')).createUpdaterMocks()
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

describe('waitForRemoteServerUpdate', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  it('resolves a status wait when the updater revision changes', async () => {
    const mainWindow = { webContents: { send: vi.fn() } }
    const {
      checkForUpdatesFromMenu,
      getRemoteServerUpdaterSnapshot,
      setupAutoUpdater,
      waitForRemoteServerUpdate
    } = await import('./updater')
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const initial = getRemoteServerUpdaterSnapshot('runtime-test')

    const pending = waitForRemoteServerUpdate('runtime-test', initial.revision, 1_000)
    checkForUpdatesFromMenu()

    await expect(pending).resolves.toMatchObject({
      revision: initial.revision + 1,
      status: { state: 'checking' },
      timedOut: false
    })
  })

  it('releases a status wait when its transport is aborted', async () => {
    const { getRemoteServerUpdaterSnapshot, waitForRemoteServerUpdate } = await import('./updater')
    const controller = new AbortController()
    const initial = getRemoteServerUpdaterSnapshot('runtime-test')

    const pending = waitForRemoteServerUpdate(
      'runtime-test',
      initial.revision,
      10_000,
      controller.signal
    )
    controller.abort()

    await expect(pending).resolves.toMatchObject({
      revision: initial.revision,
      status: initial.status,
      timedOut: true
    })
  })
})
