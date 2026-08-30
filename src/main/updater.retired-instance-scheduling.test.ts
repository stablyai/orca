import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UpdaterModule from './updater'

const { appMock, autoUpdaterMock, fetchChangelogMock, moduleFactories, resetUpdaterMocks } =
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

/** The 45s stall guard plus the 1h retry it arms — the whole window a retired guard can reach into. */
const PAST_STALL_AND_RETRY_MS = 45_000 + 60 * 60 * 1000

/** Starts a background check that never settles, so the stall guard stays armed. */
async function launchStalledCheck(): Promise<typeof UpdaterModule> {
  autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))
  const updater = await import('./updater')
  updater.setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
    getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  // Reset so anything counted below can only be a check the retired guard drove.
  autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null)
  return updater
}

describe('updater scheduling teardown', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  it('arms a retry off the stall guard while the updater is still running', async () => {
    // Why this sits ahead of the stop tests: every one of them asserts that nothing happened, and
    // nothing happens just as reliably in an updater that never schedules at all. Without this,
    // the whole file passes on a build where scheduling is stopped from the first line — so it
    // would stop reporting the loss of the behaviour it is named for.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    await launchStalledCheck()

    await vi.advanceTimersByTimeAsync(PAST_STALL_AND_RETRY_MS)

    expect(
      autoUpdaterMock.checkForUpdates,
      'a running updater never retried the check its stall guard gave up on'
    ).toHaveBeenCalled()
  })

  it('stops the stall guard from arming a retry once scheduling is stopped', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    const updater = await launchStalledCheck()
    updater.stopAutoUpdaterScheduling()

    await vi.advanceTimersByTimeAsync(PAST_STALL_AND_RETRY_MS)

    expect(
      autoUpdaterMock.checkForUpdates,
      'a stopped updater still ran a check off its stall guard'
    ).not.toHaveBeenCalled()
  })

  it('stops scheduling when the app says it is quitting', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    await launchStalledCheck()
    appMock.emit('will-quit')

    await vi.advanceTimersByTimeAsync(PAST_STALL_AND_RETRY_MS)

    expect(
      autoUpdaterMock.checkForUpdates,
      'the updater kept checking for updates while the app was quitting'
    ).not.toHaveBeenCalled()
  })

  it('leaves no armed timer behind', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    await launchStalledCheck()
    expect(vi.getTimerCount(), 'the fixture armed nothing to tear down').toBeGreaterThan(0)

    const { stopAutoUpdaterScheduling } = await import('./updater')
    stopAutoUpdaterScheduling()

    expect(vi.getTimerCount(), 'a stopped updater still owns armed timers').toBe(0)
  })

  it('does not re-arm the daily check from a result that lands after the stop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    // The changelog fetch is the real in-flight tail: 'update-available' has already been handled,
    // and the daily reschedule only happens once this resolves.
    const changelogResolvers: ((value: string | null) => void)[] = []
    fetchChangelogMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          changelogResolvers.push(resolve)
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })

    const updater = await import('./updater')
    updater.setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    updater.stopAutoUpdaterScheduling()
    for (const resolve of changelogResolvers) {
      resolve(null)
    }
    await vi.advanceTimersByTimeAsync(0)
    autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null)

    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000)

    expect(
      autoUpdaterMock.checkForUpdates,
      'a result that landed after the stop re-armed the daily check'
    ).not.toHaveBeenCalled()
  })

  it('arms nothing when a window focus asks for a check after the stop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    const updater = await import('./updater')
    updater.setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
      // A live closure, so every focus after the stop still reads as overdue.
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    updater.stopAutoUpdaterScheduling()
    expect(vi.getTimerCount()).toBe(0)

    // The focus and resume handlers outlive the stop, and both route to a background check.
    appMock.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.getTimerCount(), 'a post-stop check re-armed the updater timers').toBe(0)
  })

  it('the shared reset retires the outgoing instance', () => {
    // The reset cannot reach the timers the outgoing module armed on the real clock, so it has to
    // ask that instance to stand down. The two tests above prove what standing down does.
    const seen: string[] = []
    appMock.on('will-quit', () => {
      seen.push('will-quit')
    })

    resetUpdaterMocks()

    expect(seen, 'the shared reset left the outgoing updater scheduling').toEqual(['will-quit'])
  })
})
