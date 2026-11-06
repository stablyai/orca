import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { updaterMainWindow } from './testing/updater-test-main-window'

const {
  autoUpdaterMock,
  fetchNewerReleaseTagsMock,
  fetchLatestStableReleaseTagMock,
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

type FeedResult =
  | { tags: string[]; state: 'ready' | 'no-newer' }
  | { tags: string[]; state: 'not-ready'; lastGoodTag: string }

function holdFirstPreflight(): (value: FeedResult) => void {
  let finish = (_value: FeedResult): void => {}
  fetchNewerReleaseTagsMock.mockImplementationOnce(
    () =>
      new Promise<FeedResult>((resolve) => {
        finish = resolve
      })
  )
  return (value) => finish(value)
}

async function setup() {
  const updater = await loadUpdaterModule()
  updater.setupAutoUpdater(updaterMainWindow(vi.fn()), { getLastUpdateCheckAt: () => Date.now() })
  return updater
}

describe('updater feed preflight ownership', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    vi.useFakeTimers()
    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))
  })

  it.each(['manual', 'background'] as const)(
    'preserves a newer feed after an older %s preflight resolves',
    async (kind) => {
      const finishOld = holdFirstPreflight()
      fetchNewerReleaseTagsMock.mockResolvedValueOnce({ tags: ['v3.0.0'], state: 'ready' })
      const updater = await setup()
      if (kind === 'manual') {
        updater.checkForUpdatesFromMenu()
      } else {
        updater.checkForUpdates()
      }
      await vi.advanceTimersByTimeAsync(45_000)
      updater.checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v3.0.0'
      })
      autoUpdaterMock.setFeedURL.mockClear()

      finishOld({ tags: ['v2.0.0'], state: 'ready' })
      await vi.advanceTimersByTimeAsync(0)

      expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    }
  )

  it('does not let an expired stable fallback replace a newer feed', async () => {
    let finish = (_tag: string | null): void => {}
    fetchLatestStableReleaseTagMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const updater = await setup()
    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(45_000)
    fetchNewerReleaseTagsMock.mockResolvedValueOnce({ tags: ['v3.0.0'], state: 'ready' })
    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    autoUpdaterMock.setFeedURL.mockClear()

    finish('v2.0.0')
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})
