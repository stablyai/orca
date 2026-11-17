import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { updaterMainWindow } from './testing/updater-test-main-window'

const {
  autoUpdaterMock,

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
    vi.useFakeTimers({ now: 0 })
  })

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
})
