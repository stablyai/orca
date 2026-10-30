import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as UpdaterModule from './updater'
import type { UpdateStatus } from '../shared/update-status-types'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'
import { updaterMainWindow } from './updater-test-main-window'
import type * as RunningMoves from './persistence/moving-wsl-projects/wsl-move-running-moves'

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

vi.mock('electron', () => moduleFactories.electron())
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

warmUpdaterModule()

describe('updater install while a WSL project move runs', () => {
  let move: RunningMoves.RunningWslMove | null = null
  // The updater loads fresh modules; claim the move in the registry it reads.
  let moves: typeof RunningMoves

  beforeEach(() => {
    resetUpdaterMocks()
  })

  afterEach(() => {
    if (move) {
      moves.releaseWslMoveRun('Ubuntu', move)
      move = null
    }
  })

  async function downloadedUpdater(): Promise<{
    send: ReturnType<typeof vi.fn>
    updater: typeof UpdaterModule
  }> {
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
    moves = await import('./persistence/moving-wsl-projects/wsl-move-running-moves')
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
    return { send, updater }
  }

  function lastStatus(send: ReturnType<typeof vi.fn>): UpdateStatus | undefined {
    return send.mock.calls.findLast(([channel]) => channel === 'updater:status')?.[1]
  }

  it('holds the install, keeping the terminals and the move running, and offers it again', async () => {
    const { send, updater } = await downloadedUpdater()
    move = moves.claimWslMoveRun('Ubuntu')

    updater.quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(killAllPtyMock).not.toHaveBeenCalled()
    expect(updater.isQuittingForUpdate()).toBe(false)
    expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
    expect(lastStatus(send)).toEqual({
      state: 'error',
      message: 'A project is moving to its WSL host. Install the update once the move finishes.',
      retryAction: 'install',
      version: '1.0.61'
    })
    expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith('quit_and_install_held_for_wsl_move', {
      version: '1.0.61'
    })
  })

  it('installs once the move has finished', async () => {
    const { send, updater } = await downloadedUpdater()
    move = moves.claimWslMoveRun('Ubuntu')
    updater.quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)
    if (move) {
      moves.releaseWslMoveRun('Ubuntu', move)
      move = null
    }

    updater.quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(killAllPtyMock).toHaveBeenCalledTimes(1)
    // Only the held attempt was aborted.
    expect(
      send.mock.calls.filter(([channel]) => channel === 'updater:quitAndInstallAborted')
    ).toHaveLength(1)
  })
})
