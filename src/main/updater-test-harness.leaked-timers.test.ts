import { setTimeout as sleep } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
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

const SILENT_SETTLE_DELAY_MS = 1_000
const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

warmUpdaterModule()

describe('updater test harness real-timer tracking', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  it('cancels a real timer armed before the reset', async () => {
    let fired = false
    setTimeout(() => {
      fired = true
    }, 20)

    resetUpdaterMocks()

    await sleep(150)
    expect(fired).toBe(false)
  })

  it('still arms real timers after the reset', async () => {
    let fired = false
    setTimeout(() => {
      fired = true
    }, 10)

    await sleep(150)
    expect(fired).toBe(true)
  })

  it('hands back the untouched Node timeout handle', () => {
    const handle = setTimeout(() => {}, 60_000)

    // Why: production code calls unref() on these; the tracker must not swap in a plain id.
    expect(typeof handle.unref).toBe('function')
    handle.unref()
    clearTimeout(handle)
  })
})

// Why: this pair reproduces the cross-test leak, so it depends on running in file order — the first
// test arms the timer and the second one is the later test it used to fire into.
describe('abandoned updater instance', () => {
  let leakedStatusSend: Mock = vi.fn()

  beforeEach(() => {
    resetUpdaterMocks()
  })

  it('leaves a silent-settle timer armed when its module instance is abandoned', async () => {
    let resolveCheck: (value: unknown) => void = () => {}
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      // Why: the checking status is what makes the silent settle publish 'not-available' later.
      autoUpdaterMock.emit('checking-for-update')
      return new Promise((resolve) => {
        resolveCheck = resolve
      })
    })
    leakedStatusSend = vi.fn()

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater({ webContents: { send: leakedStatusSend } } as never, {
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    // Why: resolving without a terminal event is what arms the 1s silent settle; do it here so the
    // full delay is still ahead of us and the timer is guaranteed to be pending when this test ends.
    resolveCheck(undefined)
    await sleep(0)

    expect(leakedStatusSend).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'not-available' })
    )
  })

  it('never reaches the shared spies once the next test owns the clock', async () => {
    vi.useFakeTimers()

    // Why: real time past the settle delay — the abandoned instance would settle here and re-arm its
    // 24h auto check on this test's fake clock at its epoch.
    await sleep(SILENT_SETTLE_DELAY_MS + 300)
    await vi.advanceTimersByTimeAsync(AUTO_UPDATE_CHECK_INTERVAL_MS)

    expect(leakedStatusSend).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'not-available' })
    )
    // Why: the generation fence stops at the autoUpdater spies; this one sits past it on the
    // pinDefaultReleaseFeed chain that the stale instance's re-armed background check still reached.
    expect(fetchNewerReleaseTagsMock).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })
})
