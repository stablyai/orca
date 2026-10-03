import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'
import type * as ConflictingAppInstances from './updater-conflicting-app-instances'

type ConflictingAppInstancesModule = typeof ConflictingAppInstances

const { autoUpdaterMock, killAllPtyMock, moduleFactories, resetUpdaterMocks } = await vi.hoisted(
  async () => (await import('./updater-test-harness')).createUpdaterMocks()
)

const { findConflictingAppInstancePidsMock } = vi.hoisted(() => ({
  findConflictingAppInstancePidsMock: vi.fn<() => Promise<number[]>>()
}))

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
vi.mock('./startup/hydrate-shell-path', () => ({
  runWithLaunchPath: (action: () => unknown): unknown => action()
}))
// Why partial: the message builder stays real, so a copy change cannot make
// these pass against text no user would ever see.
vi.mock('./updater-conflicting-app-instances', async () => ({
  ...(await vi.importActual<ConflictingAppInstancesModule>('./updater-conflicting-app-instances')),
  findConflictingAppInstancePids: findConflictingAppInstancePidsMock
}))

warmUpdaterModule()

/** Asks the updater to install, then lets its deferral timer fire. */
async function requestInstall(): Promise<ReturnType<typeof vi.fn>> {
  const send = vi.fn()
  const { setupAutoUpdater, quitAndInstall } = await loadUpdaterModule()
  setupAutoUpdater({ webContents: { send } } as never)
  quitAndInstall()
  await vi.advanceTimersByTimeAsync(100)
  return send
}

function lastErrorStatus(send: ReturnType<typeof vi.fn>): Record<string, unknown> | undefined {
  return send.mock.calls
    .filter(([channel]) => channel === 'updater:status')
    .map(([, status]) => status as Record<string, unknown>)
    .findLast((status) => status.state === 'error')
}

describe('macOS install blocked by other running app instances', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    findConflictingAppInstancePidsMock.mockReset().mockResolvedValue([])
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('installs normally when this is the only running copy', async () => {
    const send = await requestInstall()

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(lastErrorStatus(send)).toBeUndefined()
  })

  it('refuses the install instead of quitting into a handoff Squirrel will abort', async () => {
    findConflictingAppInstancePidsMock.mockResolvedValue([270, 811])

    const send = await requestInstall()

    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    // Killing PTYs is destructive and only earns its keep once the install commits.
    expect(killAllPtyMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
  })

  it('puts the copies to quit on the card summary, not behind Show details', async () => {
    findConflictingAppInstancePidsMock.mockResolvedValue([270, 811])

    const send = await requestInstall()

    // Why the flag and not just the text: the update card promotes `message` to
    // its summary line only for a NON-retryable error, and otherwise shows a
    // generic "Could not complete the update." with this sentence hidden behind
    // "Show details". Marking it retryable would bury the one thing the user
    // needs, in exchange for a Retry Download that re-fetches an already-staged
    // release. Assert the summary the user actually reads, so a flip back is red.
    // The renderer half of this contract is asserted against the real card model
    // in update-card-error-model.test.ts; this pins the flag main must send.
    const status = lastErrorStatus(send)
    expect(status).toMatchObject({ state: 'error', retryable: false })
    expect(String(status?.message)).toContain('270, 811')
  })

  it('leaves the update installable after a refusal, once the other copy quits', async () => {
    findConflictingAppInstancePidsMock.mockResolvedValue([270])
    const { setupAutoUpdater, quitAndInstall } = await loadUpdaterModule()
    setupAutoUpdater({ webContents: { send: vi.fn() } } as never)

    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

    // Why this matters: the refusal must release the in-progress claim, or the
    // retry the message asks for would be swallowed as a duplicate request.
    findConflictingAppInstancePidsMock.mockResolvedValue([])
    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('installs anyway when the conflict scan throws, without latching or escaping', async () => {
    // The scan runs outside the install span's catch and its claim is held across
    // the await, so a rejection would both escape unhandled and latch every later
    // install into `quit_and_install_ignored` — no card, no recovery short of a
    // relaunch. Failing open is the probe's own contract: an unavailable scan
    // must never block an install. The probe cannot throw today; this pins that
    // a future one changing that cannot strand the user.
    findConflictingAppInstancePidsMock.mockRejectedValueOnce(new Error('probe exploded'))
    const { setupAutoUpdater, quitAndInstall } = await loadUpdaterModule()
    setupAutoUpdater({ webContents: { send: vi.fn() } } as never)

    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('ignores a duplicate install request that arrives during the conflict scan', async () => {
    let releaseScan: (pids: number[]) => void = () => {}
    findConflictingAppInstancePidsMock.mockReturnValue(
      new Promise<number[]>((resolve) => {
        releaseScan = resolve
      })
    )
    const { setupAutoUpdater, quitAndInstall } = await loadUpdaterModule()
    setupAutoUpdater({ webContents: { send: vi.fn() } } as never)

    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)
    // The scan is the first await in the install, so a second request lands
    // inside a window where no install state has been set yet.
    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)
    releaseScan([])
    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
