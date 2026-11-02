import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'
import { updaterMainWindow } from './updater-test-main-window'

const {
  appMock,
  autoUpdaterMock,
  fetchNewerReleaseTagsMock,
  fetchLatestStableReleaseTagMock,
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

const DAY_MS = 24 * 60 * 60 * 1000
const RELEASED_AT = Date.parse('2026-11-01T00:00:00Z')

function heldResult(): unknown {
  return {
    tags: [],
    state: 'no-newer',
    releaseDelay: {
      heldRelease: { tag: 'v1.4.3', version: '1.4.3', releasedAt: RELEASED_AT },
      isTagOldEnough: () => false
    }
  }
}

describe('updater update delay', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    appMock.getVersion.mockReturnValue('1.4.1')
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
  })

  it('reports a held release without launching a check or falling back to latest stable', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue(heldResult())
    fetchLatestStableReleaseTagMock.mockResolvedValue('v1.4.3')
    const sendMock = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(updaterMainWindow(sendMock), {
      getLastUpdateCheckAt: () => Date.now(),
      getUpdateDelayDays: () => 7
    })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenLastCalledWith('updater:status', {
        state: 'not-available',
        userInitiated: true,
        delayedUpdate: {
          version: '1.4.3',
          releasedAt: new Date(RELEASED_AT).toISOString(),
          availableAt: new Date(RELEASED_AT + 7 * DAY_MS).toISOString(),
          delayDays: 7
        }
      })
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith(
      '1.4.1',
      1,
      expect.objectContaining({ minReleaseAgeMs: 7 * DAY_MS })
    )
    expect(fetchLatestStableReleaseTagMock).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('skips the delay once when the user asks for the held release now', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.4.3'])
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(updaterMainWindow(vi.fn()), {
      getLastUpdateCheckAt: () => Date.now(),
      getUpdateDelayDays: () => 7
    })

    checkForUpdatesFromMenu({ ignoreUpdateDelay: true })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.4.3'
      })
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenLastCalledWith('1.4.1', 1, {
      includePrerelease: false
    })
  })
})
