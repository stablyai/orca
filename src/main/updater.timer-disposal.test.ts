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

// Why: the leaked timer is armed on the real clock, so waiting it out must survive vi.useFakeTimers().
const realSetTimeout = globalThis.setTimeout
const SETTLE_DELAY_MS = 150
const DAY_MS = 24 * 60 * 60 * 1000

const mainWindow = () => ({ webContents: { send: vi.fn() } }) as never

const waitRealMs = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms))

describe('updater timer disposal', () => {
  beforeEach(async () => {
    await resetUpdaterMocks()
  })

  it('leaves a silent-settle timer pending when a real-timer test ends mid-check', async () => {
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow(), {
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000,
      silentSettleDelayMs: SETTLE_DELAY_MS
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps the discarded instance from arming a check on the next test clock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow(), { getLastUpdateCheckAt: () => Date.now() })

    // Why: real time the previous instance's leaked settle timer would need to fire into this clock.
    await waitRealMs(SETTLE_DELAY_MS * 4)
    await vi.advanceTimersByTimeAsync(DAY_MS + 60 * 1000)

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})
