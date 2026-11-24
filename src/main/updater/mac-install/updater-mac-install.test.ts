import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { app, autoUpdater, powerMonitor } from 'electron'
import { UpdaterSetup } from '../lifecycle/updater-setup'
import {
  MAC_DEFERRED_STAGING_TIMEOUT_MS,
  MAC_INTERACTIVE_STAGING_TIMEOUT_MS
} from '../lifecycle/updater-state'
import { beginMacUpdateDownload, isMacInstallerReady } from './updater-mac-install'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '1.4.272' }),
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
  setFeedURL: () => {},
  checkForUpdates: async () => {
    jsUpdater.emit('checking-for-update')
    jsUpdater.emit('update-available', { version })
  },
  downloadUpdate: async () => []
})

afterEach(() => {
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
