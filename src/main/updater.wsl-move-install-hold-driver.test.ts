/**
 * #34813 end to end in-process: the real updater install path against a real move run of the WSL
 * move driver over a real orcad profile store (the fault-injection rig). An install attempted while
 * the move runs is held with its message; once the move settles (moved, failed, cancelled or killed
 * mid-run and recovered on relaunch) the same staged update installs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as UpdaterModule from './updater'
import type { UpdateStatus } from '../shared/update-status-types'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../shared/wsl-host-internal-gate'
import type { WslMoveResult } from '../shared/wsl-move/wsl-move-driver-types'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'
import { updaterMainWindow } from './updater-test-main-window'
import type * as RigModule from './persistence/__fixtures__/wsl-mover/wsl-move-kill-rig'
import type * as RewriteStores from './persistence/moving-wsl-projects/wsl-move-desktop-rewrite-stores'
import type * as Driver from './persistence/moving-wsl-projects/wsl-move-driver'
import type * as RunningMoves from './persistence/moving-wsl-projects/wsl-move-running-moves'
import type * as ReleaseHere from './ipc/wsl-move-release-here'
import type * as Retention from './persistence/moving-wsl-projects/wsl-move-retention'

const {
  nativeUpdaterMock,
  autoUpdaterMock,
  killAllPtyMock,
  getLinuxRootPackageTypeMock,
  recordUpdaterLifecycleMock,
  fetchNewerReleaseTagsMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())
// The host store's profile dir, from the persistence harness loaded beside the updater.
const profile = vi.hoisted(() => ({ state: { dir: '' } }))

// The updater's Electron fakes, plus the profile path and keychain the move's host store reads.
vi.mock('electron', () => {
  const electron = moduleFactories.electron()
  return {
    ...electron,
    app: Object.assign(electron.app, { getPath: () => profile.state.dir }),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
      decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
    }
  }
})
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('./ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 1 }))
}))

warmUpdaterModule()

/** The mover, loaded after the updater so both read one running-moves registry. */
type Mover = {
  rig: RigModule.WslMoveRig
  fixture: typeof RigModule
  driver: typeof Driver
  moves: typeof RunningMoves
  rewriteStores: typeof RewriteStores
  releaseHere: typeof ReleaseHere
  retention: typeof Retention
}

let mover: Mover | null = null

async function loadMover(): Promise<Mover> {
  const harness = await import('./persistence/persistence-test-harness')
  // Read live: the rig points the harness at a fresh profile dir before it opens the host store.
  profile.state = harness.testState
  const fixture = await import('./persistence/__fixtures__/wsl-mover/wsl-move-kill-rig')
  const loaded: Mover = {
    rig: fixture.createWslMoveKillRig(),
    fixture,
    driver: await import('./persistence/moving-wsl-projects/wsl-move-driver'),
    moves: await import('./persistence/moving-wsl-projects/wsl-move-running-moves'),
    rewriteStores:
      await import('./persistence/moving-wsl-projects/wsl-move-desktop-rewrite-stores'),
    releaseHere: await import('./ipc/wsl-move-release-here'),
    retention: await import('./persistence/moving-wsl-projects/wsl-move-retention')
  }
  mover = loaded
  return loaded
}

beforeEach(() => {
  resetUpdaterMocks()
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  // A killed run's catch handlers warn about the calls that now throw.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  mover?.rewriteStores.resetWslMoveDesktopRewriteStoresForTests()
  mover?.fixture.removeWslMoveRigDirs()
  mover = null
})

type Staged = { send: ReturnType<typeof vi.fn>; updater: typeof UpdaterModule; mover: Mover }

/** An interactive install with a downloaded update, left on real timers for the move. */
async function stagedUpdate(): Promise<Staged> {
  getLinuxRootPackageTypeMock.mockReturnValue(null)
  vi.useFakeTimers()
  fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
  autoUpdaterMock.checkForUpdates.mockImplementation(() => {
    autoUpdaterMock.emit('checking-for-update')
    queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
    return Promise.resolve(undefined)
  })
  const send = vi.fn()
  const updater = await loadUpdaterModule()
  updater.setupAutoUpdater(updaterMainWindow(send), {
    getLastUpdateCheckAt: () => Date.now(),
    installMode: 'interactive'
  })
  updater.checkForUpdatesFromMenu()
  await vi.advanceTimersByTimeAsync(0)
  autoUpdaterMock.downloadUpdate.mockResolvedValue([])
  updater.downloadUpdate()
  autoUpdaterMock.emit('update-downloaded', {
    version: '1.0.61',
    downloadedFile: join(tmpdir(), 'Orca-1.0.61.AppImage'),
    files: []
  })
  if (process.platform === 'darwin') {
    const ready = nativeUpdaterMock.on.mock.calls.find(
      ([eventName]) => eventName === 'update-downloaded'
    )?.[1]
    if (typeof ready === 'function') {
      ready()
    }
  }
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  return { send, updater, mover: await loadMover() }
}

/** The user presses Install; the install path's own timers run on fake time. */
async function pressInstall({ updater }: Staged): Promise<void> {
  vi.useFakeTimers()
  updater.quitAndInstall()
  await vi.advanceTimersByTimeAsync(100)
  vi.useRealTimers()
}

/** A move started and stopped where it reaches for the host, until `release`. */
function pausedMove({ rig: r, driver, fixture }: Mover): {
  run: Promise<WslMoveResult | 'killed'>
  release: () => void
} {
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    release = resolve
  })
  const connect = r.world.deps.connectHost
  r.world.deps.connectHost = async (distro) => {
    await reached
    return connect(distro)
  }
  const run = driver
    .moveProjectsToWslHost(r.world.deps, fixture.WSL_MOVE_RIG_REQUEST)
    .catch(() => 'killed' as const)
  return { run, release }
}

const MOVE_HELD = {
  message: 'A project is moving to its WSL host. Install the update once the move finishes.',
  lifecycleEvent: 'quit_and_install_held_for_wsl_move'
}
const UNDO_HELD = {
  message: 'A project is coming back from its WSL host. Install the update once that finishes.',
  lifecycleEvent: 'quit_and_install_held_for_wsl_move_undo'
}

function expectHeld({ send }: Staged, held = MOVE_HELD): void {
  expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
  expect(killAllPtyMock).not.toHaveBeenCalled()
  expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
  const status: UpdateStatus | undefined = send.mock.calls.findLast(
    ([channel]) => channel === 'updater:status'
  )?.[1]
  expect(status).toEqual({
    state: 'error',
    message: held.message,
    retryAction: 'install',
    version: '1.0.61'
  })
  expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(held.lifecycleEvent, {
    version: '1.0.61'
  })
}

function expectInstalled({ send }: Staged): void {
  expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
  expect(killAllPtyMock).toHaveBeenCalledTimes(1)
  // Only the attempt made during the move was aborted.
  expect(
    send.mock.calls.filter(([channel]) => channel === 'updater:quitAndInstallAborted')
  ).toHaveLength(1)
}

describe('an app update while a real WSL project move runs (#34813)', () => {
  it('is held while the move runs, and installs once it has moved', async () => {
    const staged = await stagedUpdate()
    const move = pausedMove(staged.mover)
    expect(staged.mover.moves.isAnyWslMoveRunning()).toBe(true)

    await pressInstall(staged)
    expectHeld(staged)

    move.release()
    expect(await move.run).toMatchObject({ outcome: 'moved' })
    expect(staged.mover.moves.isAnyWslMoveRunning()).toBe(false)
    await pressInstall(staged)
    expectInstalled(staged)
  })

  it('installs once a move fails because its host does not answer', async () => {
    const staged = await stagedUpdate()
    const move = pausedMove(staged.mover)

    await pressInstall(staged)
    expectHeld(staged)

    // The host goes away while the move waits to reach it.
    staged.mover.rig.hostPresent = false
    move.release()
    expect(await move.run).toMatchObject({ outcome: 'refused' })
    expect(staged.mover.moves.isAnyWslMoveRunning()).toBe(false)
    await pressInstall(staged)
    expectInstalled(staged)
  })

  it('installs once the user cancels the move', async () => {
    const staged = await stagedUpdate()
    const move = pausedMove(staged.mover)

    await pressInstall(staged)
    expectHeld(staged)

    expect(staged.mover.moves.cancelWslMove('Ubuntu')).toBe(true)
    move.release()
    expect(await move.run).toMatchObject({ outcome: 'refused', code: 'wsl_move_cancelled' })
    await pressInstall(staged)
    expectInstalled(staged)
  })

  it('installs after the desktop is killed mid-move and the relaunch recovers it', async () => {
    const staged = await stagedUpdate()
    // Killed at the pause, after the move has journaled its cutover.
    staged.mover.rig.kill.killAt = 'sleep'
    const move = pausedMove(staged.mover)

    await pressInstall(staged)
    expectHeld(staged)

    move.release()
    await move.run
    expect(staged.mover.rig.kill.dead).toBe(true)
    // The next launch starts with no move running and settles the interrupted one.
    await staged.mover.fixture.restartWslMoveRig(staged.mover.rig, {
      hostUp: true,
      orcadRestarted: false
    })
    expect(staged.mover.fixture.wslMoveRigOutcome(staged.mover.rig)).not.toBe('stuck')
    expect(staged.mover.moves.isAnyWslMoveRunning()).toBe(false)
    await pressInstall(staged)
    expectInstalled(staged)
  })

  it('is held while "Use on this computer again" brings a moved project back, then installs', async () => {
    const staged = await stagedUpdate()
    const { rig, driver, fixture, releaseHere, retention, moves } = staged.mover
    expect(
      await driver.moveProjectsToWslHost(rig.world.deps, fixture.WSL_MOVE_RIG_REQUEST)
    ).toMatchObject({
      outcome: 'moved'
    })
    await retention.runWslMoveRetentionPass({
      userDataPath: rig.userDataPath,
      store: fixture.wslMoveRigRetentionStore(rig)
    })
    let hostStopped!: () => void
    const stopping = new Promise<void>((resolve) => {
      hostStopped = resolve
    })
    const undo = releaseHere.releaseWslMovedProjectHere(
      rig.userDataPath,
      { repoId: 'repo-1' },
      [],
      () => ({
        // Paused while the host's copies of the project's terminals stop.
        stopHostCopies: async () => (await stopping, 'stopped' as const)
      })
    )
    // An undo is not a move: the move prompt, Cancel and the driver do not see it.
    expect(moves.isAnyWslMoveRunning()).toBe(false)

    await pressInstall(staged)
    expectHeld(staged, UNDO_HELD)

    hostStopped()
    expect(await undo).toMatchObject({ released: true })
    await pressInstall(staged)
    expectInstalled(staged)
  })
})
