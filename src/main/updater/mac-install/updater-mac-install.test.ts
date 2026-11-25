import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app, autoUpdater, powerMonitor } from 'electron'
import { UpdaterSetup } from '../lifecycle/updater-setup'
import {
  MAC_DEFERRED_STAGING_TIMEOUT_MS,
  MAC_INTERACTIVE_STAGING_TIMEOUT_MS
} from '../lifecycle/updater-state'
import {
  beginMacUpdateDownload,
  isMacInstallerReady,
  isMacInstallRequested
} from './updater-mac-install'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), {
      isPackaged: true,
      getVersion: () => '1.4.272',
      quit: vi.fn()
    }),
    autoUpdater: new EventEmitter(),
    powerMonitor: new EventEmitter()
  }
})
vi.mock('./shipit-leftover-recovery', () => ({ prepareThisProcessShipItStaging: () => null }))
vi.mock('./macos-shipit-scheduling', () => ({ configureMacShipItScheduling: () => {} }))
vi.mock('../electron-updater-loader', () => ({ loadElectronAutoUpdater: () => jsUpdater }))
vi.mock('../releases/updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: async () => ({ state: 'ready', tags: [`v${version}`] })
}))
vi.mock('../releases/updater-changelog', () => ({ fetchChangelog: async () => null }))

const version = '1.4.273'
const jsUpdater = Object.assign(new EventEmitter(), {
  setFeedURL: vi.fn((_options: { url?: string }) => {}),
  checkForUpdates: async () => {
    jsUpdater.emit('checking-for-update')
    jsUpdater.emit('update-available', { version })
  },
  downloadUpdate: vi.fn(async (): Promise<string[]> => []),
  quitAndInstall: vi.fn()
})

afterEach(() => {
  vi.mocked(app.quit).mockClear()
  jsUpdater.setFeedURL.mockClear()
  jsUpdater.quitAndInstall.mockClear()
  jsUpdater.downloadUpdate.mockClear()
  vi.clearAllTimers()
  vi.useRealTimers()
  autoUpdater.removeAllListeners()
  app.removeAllListeners()
  powerMonitor.removeAllListeners()
  jsUpdater.removeAllListeners()
  beginMacUpdateDownload()
})

it.runIf(process.platform === 'darwin')(
  'keeps a timed-out attempt as the only owner of native staging',
  async () => {
    // Keep the unrelated nudge fetch inside its startup cooldown.
    vi.useFakeTimers({ now: 0 })
    const updater = new UpdaterSetup()
    updater.setupAutoUpdater(null, { getLastUpdateCheckAt: () => Date.now() })

    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    updater.downloadUpdate()
    jsUpdater.emit('update-downloaded', { version })
    vi.advanceTimersByTime(MAC_INTERACTIVE_STAGING_TIMEOUT_MS)
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'error', version, retryable: false })

    updater.downloadUpdate()
    expect(updater.getUpdateStatus().state).toBe('error')
    expect(isMacInstallerReady(version)).toBe(false)

    autoUpdater.emit('update-downloaded')
    expect(updater.getUpdateStatus()).toMatchObject({
      state: 'downloaded',
      version,
      installOnQuit: true
    })

    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    updater.downloadUpdate()
    autoUpdater.emit('update-downloaded')
    expect(updater.getUpdateStatus()).toEqual({ state: 'downloading', version, percent: 0 })

    jsUpdater.emit('update-downloaded', { version })
    autoUpdater.emit('update-downloaded')
    expect(updater.getUpdateStatus()).toMatchObject({
      state: 'downloaded',
      version,
      installOnQuit: true
    })
  }
)

it.runIf(process.platform === 'darwin')(
  'keeps slow but healthy macOS staging in progress until Squirrel finishes',
  async () => {
    vi.useFakeTimers({ now: 0 })
    const updater = new UpdaterSetup()
    updater.setupAutoUpdater(null, { getLastUpdateCheckAt: () => Date.now() })

    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    updater.downloadUpdate()
    jsUpdater.emit('update-downloaded', { version })
    // A busy Mac took minutes to stage; that is progress, not a failed download.
    vi.advanceTimersByTime(Math.max(MAC_DEFERRED_STAGING_TIMEOUT_MS, 9 * 60 * 1000))
    expect(updater.getUpdateStatus()).toEqual({ state: 'downloading', version, percent: 100 })

    autoUpdater.emit('update-downloaded')
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloaded', version })
  }
)

async function startStaging({ automatic = false } = {}): Promise<UpdaterSetup> {
  vi.useFakeTimers({ now: 0 })
  const updater = new UpdaterSetup()
  updater.setupAutoUpdater(null, {
    getLastUpdateCheckAt: () => Date.now(),
    getAutomaticUpdates: () => automatic
  })
  updater.checkForUpdatesFromMenu()
  await vi.advanceTimersByTimeAsync(0)
  updater.downloadUpdate(automatic)
  jsUpdater.emit('update-downloaded', { version })
  return updater
}

// MacUpdater forwards a native failure to its own listeners before Orca's native listener runs.
function failNativeStaging(message: string): void {
  const error = new Error(message)
  jsUpdater.emit('error', error)
  autoUpdater.emit('error', error)
}

it.runIf(process.platform === 'darwin')(
  'shows macOS staging guidance at fifteen minutes, not before',
  async () => {
    const updater = await startStaging()
    vi.advanceTimersByTime(899_999)
    expect(updater.getUpdateStatus()).toEqual({ state: 'downloading', version, percent: 100 })

    vi.advanceTimersByTime(1)
    expect(updater.getUpdateStatus()).toMatchObject({
      state: 'error',
      version,
      retryable: false,
      messageCode: 'macStagingTimeout'
    })
  }
)

it.runIf(process.platform === 'darwin')(
  'refuses a build switch while macOS stages, then accepts it after a late native failure',
  async () => {
    const updater = await startStaging()
    vi.advanceTimersByTime(900_000)
    const pinnedFeedCalls = (): unknown[] =>
      jsUpdater.setFeedURL.mock.calls.filter(([options]) => options.url?.includes('v1.4.274'))

    updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.274' })
    await vi.advanceTimersByTimeAsync(0)
    expect(pinnedFeedCalls()).toHaveLength(0)

    failNativeStaging('Could not locate update bundle')
    const failed = updater.getUpdateStatus()
    expect(failed).toEqual({
      state: 'error',
      failurePhase: 'download',
      version,
      message: 'Could not locate update bundle'
    })

    updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.274' })
    await vi.advanceTimersByTimeAsync(0)
    expect(pinnedFeedCalls()).toHaveLength(1)
  }
)

function requestQuit(): { preventDefault: ReturnType<typeof vi.fn>; defaultPrevented: boolean } {
  const quitEvent = { preventDefault: vi.fn(), defaultPrevented: false }
  app.emit('before-quit', quitEvent)
  return quitEvent
}

const pinnedFeedCalls = (): unknown[] =>
  jsUpdater.setFeedURL.mock.calls.filter(([options]) => options.url?.includes('v1.4.274'))

it.runIf(process.platform === 'darwin')(
  'shows the ready update without an automatic install when readiness ends a held Quit a window vetoes',
  async () => {
    const updater = await startStaging({ automatic: true })
    vi.advanceTimersByTime(899_000)
    expect(requestQuit().preventDefault).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1_000)
    expect(updater.getUpdateStatus()).toMatchObject({ messageCode: 'macStagingTimeout' })

    vi.advanceTimersByTime(1_000)
    autoUpdater.emit('update-downloaded')
    // The mocked app.quit stands in for a Quit whose window close was vetoed: the app keeps running.
    expect(app.quit).toHaveBeenCalledOnce()
    const ready = updater.getUpdateStatus()
    expect(ready).toMatchObject({ state: 'downloaded', version, installOnQuit: true })
    expect(ready).not.toHaveProperty('installing')
    // No install preflight was queued, so the continued Quit is not vetoed.
    expect(requestQuit().preventDefault).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(jsUpdater.quitAndInstall).not.toHaveBeenCalled()
    updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.274' })
    await vi.advanceTimersByTimeAsync(0)
    expect(pinnedFeedCalls()).toHaveLength(1)
  }
)

it.runIf(process.platform === 'darwin')(
  'still installs automatically on readiness when no Quit is held',
  async () => {
    const updater = await startStaging({ automatic: true })
    vi.advanceTimersByTime(901_000)
    autoUpdater.emit('update-downloaded')
    expect(updater.getUpdateStatus()).toMatchObject({
      state: 'downloaded',
      version,
      installing: true
    })
  }
)

// A Restart delivered late (before or after the guidance deadline) waits for Squirrel; its failure retires it.
describe.runIf(process.platform === 'darwin').each([
  { when: 'before the deadline', restartAt: 899_000 },
  { when: 'after the deadline', restartAt: 901_000 }
])('a Restart delivered $when', ({ restartAt }) => {
  it('is retired by a native failure and leaves no install or quit behind', async () => {
    const updater = await startStaging()
    vi.advanceTimersByTime(restartAt)
    updater.quitAndInstall()
    expect(isMacInstallRequested()).toBe(true)
    vi.advanceTimersByTime(902_000 - restartAt)
    expect(updater.getUpdateStatus()).toMatchObject({ messageCode: 'macStagingTimeout' })

    failNativeStaging('Could not locate update bundle')
    expect(isMacInstallRequested()).toBe(false)
    expect(updater.getUpdateStatus()).toEqual({
      state: 'error',
      failurePhase: 'download',
      version,
      message: 'Could not locate update bundle'
    })

    vi.advanceTimersByTime(60_000)
    expect(jsUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
    updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.274' })
    await vi.advanceTimersByTimeAsync(0)
    expect(pinnedFeedCalls()).toHaveLength(1)
  })
})

it.runIf(process.platform === 'darwin')(
  'admits a Restart once Squirrel has staged the update',
  async () => {
    const updater = await startStaging()
    vi.advanceTimersByTime(901_000)
    autoUpdater.emit('update-downloaded')
    updater.quitAndInstall()
    expect(isMacInstallRequested()).toBe(false)
    // The admitted install holds quits while its preflight runs.
    expect(requestQuit().preventDefault).toHaveBeenCalledOnce()
  }
)

// Squirrel still owns the attempt after a JS-side failure; the staging status (and its guidance) stays until a native result.
describe.runIf(process.platform === 'darwin').each([
  {
    source: 'error event',
    fail: (): void => {
      jsUpdater.emit('error', new Error('ZIP read failed'))
    }
  },
  { source: 'download promise rejection', fail: null }
])('a JS-only $source while Squirrel stages', ({ fail }) => {
  it('keeps the staging status and fence until the native result, then recovers', async () => {
    let rejectDownload: (error: Error) => void = () => {}
    if (!fail) {
      jsUpdater.downloadUpdate.mockImplementationOnce(
        () =>
          new Promise<string[]>((_resolve, reject) => {
            rejectDownload = reject
          })
      )
    }
    const updater = await startStaging()
    vi.advanceTimersByTime(60_000)
    if (fail) {
      fail()
    } else {
      rejectDownload(new Error('ZIP read failed'))
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(updater.getUpdateStatus()).toEqual({ state: 'downloading', version, percent: 100 })
    updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.274' })
    await vi.advanceTimersByTimeAsync(0)
    expect(pinnedFeedCalls()).toHaveLength(0)

    vi.advanceTimersByTime(840_000)
    expect(updater.getUpdateStatus()).toMatchObject({ messageCode: 'macStagingTimeout' })

    failNativeStaging('Could not locate update bundle')
    expect(updater.getUpdateStatus()).toEqual({
      state: 'error',
      failurePhase: 'download',
      version,
      message: 'Could not locate update bundle'
    })
    updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.274' })
    await vi.advanceTimersByTimeAsync(0)
    expect(pinnedFeedCalls()).toHaveLength(1)
  })
})

// A held ordinary Quit ends only on a native result or its 15 s fallback, on both sides of the guidance deadline.
describe.runIf(process.platform === 'darwin').each([
  { when: 'before the deadline', quitAt: 3 * 60_000 },
  { when: 'across the deadline', quitAt: 899_000 }
])('a Quit held $when', ({ quitAt }) => {
  async function holdQuit(): Promise<UpdaterSetup> {
    const updater = await startStaging()
    vi.advanceTimersByTime(quitAt)
    expect(requestQuit().preventDefault).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(2_000)
    return updater
  }

  function expectOneUpdaterContinuation(): void {
    expect(app.quit).toHaveBeenCalledOnce()
    expect(requestQuit().preventDefault).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(app.quit).toHaveBeenCalledOnce()
  }

  it('resumes once when Squirrel reports a staging failure', async () => {
    const updater = await holdQuit()
    failNativeStaging('Could not locate update bundle')
    expect(updater.getUpdateStatus()).toEqual({
      state: 'error',
      failurePhase: 'download',
      version,
      message: 'Could not locate update bundle'
    })
    expectOneUpdaterContinuation()
  })

  it('stays held through a JS-only error until its fallback', async () => {
    await holdQuit()
    jsUpdater.emit('error', new Error('ZIP read failed'))
    expect(app.quit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(12_999)
    expect(app.quit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expectOneUpdaterContinuation()
  })

  it('survives a Restart that arrives while held, then resumes once on native failure', async () => {
    const updater = await holdQuit()
    updater.quitAndInstall()
    jsUpdater.emit('error', new Error('ZIP read failed'))
    failNativeStaging('Could not locate update bundle')
    expect(isMacInstallRequested()).toBe(false)
    expectOneUpdaterContinuation()
    expect(jsUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('falls back once after 15 s of native silence', async () => {
    await holdQuit()
    vi.advanceTimersByTime(12_999)
    expect(app.quit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expectOneUpdaterContinuation()
  })
})
