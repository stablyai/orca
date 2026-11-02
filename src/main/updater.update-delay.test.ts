import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const NOW = RELEASED_AT + 2 * DAY_MS

function heldResult(releasedAt: number | null = RELEASED_AT): unknown {
  return {
    tags: [],
    state: 'no-newer',
    releaseDelay: {
      heldRelease: { tag: 'v1.4.3', version: '1.4.3', releasedAt },
      isTagOldEnough: () => false
    }
  }
}

describe('updater update delay', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    // Fake only Date so a fixed "last checked" time suppresses the startup check while vi.waitFor keeps real timers.
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    appMock.getVersion.mockReturnValue('1.4.1')
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([RELEASED_AT, null])(
    'holds a release dated %s without fabricating timestamps or falling back',
    async (releasedAt) => {
      fetchNewerReleaseTagsMock.mockResolvedValue(heldResult(releasedAt))
      fetchLatestStableReleaseTagMock.mockResolvedValue('v1.4.3')
      const sendMock = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
      setupAutoUpdater(updaterMainWindow(sendMock), {
        getLastUpdateCheckAt: () => NOW,
        getUpdateDelayDays: () => 7
      })

      checkForUpdatesFromMenu()

      await vi.waitFor(() => {
        expect(sendMock).toHaveBeenLastCalledWith('updater:status', {
          state: 'not-available',
          userInitiated: true,
          ...(releasedAt === null
            ? {}
            : {
                delayedUpdate: {
                  version: '1.4.3',
                  releasedAt: new Date(RELEASED_AT).toISOString(),
                  availableAt: new Date(RELEASED_AT + 7 * DAY_MS).toISOString(),
                  delayDays: 7
                }
              })
        })
      })
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith(
        '1.4.1',
        1,
        expect.objectContaining({ minReleaseAgeMs: 7 * DAY_MS })
      )
      expect(fetchLatestStableReleaseTagMock).not.toHaveBeenCalled()
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    }
  )

  it('does not bypass the delay through stable fallback when the feed is unavailable', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'unavailable',
      unavailableReason: 'feed'
    })
    fetchLatestStableReleaseTagMock.mockResolvedValue('v1.4.3')
    const sendMock = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(updaterMainWindow(sendMock), {
      getLastUpdateCheckAt: () => NOW,
      getUpdateDelayDays: () => 7
    })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenLastCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          messageCode: 'updateServerUnreachable'
        })
      )
    })
    expect(fetchLatestStableReleaseTagMock).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('skips the delay once when the user asks for the held release now', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.4.3'])
    const sendMock = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(updaterMainWindow(sendMock), {
      getLastUpdateCheckAt: () => NOW,
      getUpdateDelayDays: () => 7
    })

    checkForUpdatesFromMenu({ ignoreUpdateDelay: true })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.4.3'
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenLastCalledWith('1.4.1', 1, {
      includePrerelease: false
    })

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available', { version: '1.4.1' })
    fetchNewerReleaseTagsMock.mockResolvedValue(heldResult())
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenLastCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'not-available',
          delayedUpdate: expect.objectContaining({ version: '1.4.3', delayDays: 7 })
        })
      )
    })
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('checks automatically when a manually checked held release clears the delay', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const halfHour = 30 * 60 * 1000
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce(heldResult(NOW - 7 * DAY_MS + halfHour))
      .mockResolvedValue({
        tags: ['v1.4.3'],
        state: 'ready',
        releaseDelay: { heldRelease: null, isTagOldEnough: () => true }
      })
    const sendMock = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(updaterMainWindow(sendMock), {
      getLastUpdateCheckAt: () => NOW,
      getUpdateDelayDays: () => 7
    })

    checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    expect(sendMock).toHaveBeenLastCalledWith(
      'updater:status',
      expect.objectContaining({
        state: 'not-available',
        userInitiated: true,
        delayedUpdate: expect.objectContaining({ version: '1.4.3' })
      })
    )

    await vi.advanceTimersByTimeAsync(halfHour)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.3'
    })
  })

  it('honors a one-time bypass requested while another check is in flight', async () => {
    const firstFeed = Promise.withResolvers<unknown>()
    fetchNewerReleaseTagsMock.mockReturnValueOnce(firstFeed.promise).mockResolvedValue(['v1.4.3'])
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(updaterMainWindow(vi.fn()), {
      getLastUpdateCheckAt: () => NOW,
      getUpdateDelayDays: () => 7
    })

    checkForUpdatesFromMenu()
    checkForUpdatesFromMenu({ ignoreUpdateDelay: true })
    firstFeed.resolve(heldResult())

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(2)
    expect(fetchNewerReleaseTagsMock).toHaveBeenNthCalledWith(
      1,
      '1.4.1',
      1,
      expect.objectContaining({ minReleaseAgeMs: 7 * DAY_MS })
    )
    expect(fetchNewerReleaseTagsMock).toHaveBeenLastCalledWith('1.4.1', 1, {
      includePrerelease: false
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.3'
    })
  })
})
