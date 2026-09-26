import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const { autoUpdaterMock, fetchNewerReleaseTagsMock, moduleFactories, resetUpdaterMocks } =
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

type FeedResult =
  | { tags: string[]; state: 'ready' | 'no-newer' }
  | { tags: string[]; state: 'not-ready'; lastGoodTag: string }

const expiredResults: FeedResult[] = [
  { tags: ['v2.0.0'], state: 'ready' },
  { tags: [], state: 'no-newer' },
  { tags: [], state: 'not-ready', lastGoodTag: 'v1.9.0' }
]

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
  const mainWindow = { webContents: { send: vi.fn() } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only webContents.send is used; all native Electron APIs are mocked.
  updater.setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
  return updater
}

describe('updater feed preflight ownership', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    vi.useFakeTimers()
    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))
  })

  it.each(expiredResults)('does not repin after a timed-out $state result', async (result) => {
    const finish = holdFirstPreflight()
    const updater = await setup()
    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(45_000)
    const settledStatus = updater.getUpdateStatus()
    expect(settledStatus.state).toBe('error')
    autoUpdaterMock.setFeedURL.mockClear()

    finish(result)
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.getUpdateStatus()).toBe(settledStatus)
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

  it.each([
    {
      result: { tags: ['v3.0.0'], state: 'ready' },
      url: 'https://github.com/stablyai/orca/releases/download/v3.0.0'
    },
    {
      result: { tags: [], state: 'no-newer' },
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    }
  ])('keeps the active $result.state feed choice', async ({ result, url }) => {
    fetchNewerReleaseTagsMock.mockResolvedValueOnce(result)
    const updater = await setup()
    autoUpdaterMock.setFeedURL.mockClear()
    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({ provider: 'generic', url })
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})
