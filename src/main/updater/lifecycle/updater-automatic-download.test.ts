import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdaterSetup } from './updater-setup'

const { autoUpdater, nativeUpdater } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return {
    autoUpdater: Object.assign(new EventEmitter(), {
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn<() => Promise<unknown>>(),
      downloadUpdate: vi.fn(async () => [])
    }),
    nativeUpdater: new EventEmitter()
  }
})

vi.mock('electron', () => ({
  app: Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '1.0.0' }),
  autoUpdater: nativeUpdater,
  powerMonitor: new EventEmitter()
}))
vi.mock('../electron-updater-loader', () => ({ loadElectronAutoUpdater: () => autoUpdater }))
vi.mock('../mac-install/macos-shipit-scheduling', () => ({ configureMacShipItScheduling: vi.fn() }))
vi.mock('../mac-install/shipit-leftover-recovery', () => ({
  prepareThisProcessShipItStaging: () => null
}))
vi.mock('../linux-package/linux-update-package-type', () => ({
  getLinuxPackageType: () => 'non-root',
  getLinuxRootPackageType: () => null,
  isExternallyManagedLinuxInstall: () => false
}))
vi.mock('../nudges/nudge-campaign', () => ({ fetchNudge: async () => null }))
vi.mock('../releases/updater-changelog', () => ({ fetchChangelog: async () => null }))
vi.mock('../updater-lifecycle-diagnostics', () => ({ recordUpdaterLifecycle: vi.fn() }))
vi.mock('../../cli/appimage/appimage-copy-pre-extraction', () => ({
  preExtractDownloadedAppImageUpdate: async () => false
}))

class ReleaseUpdater extends UpdaterSetup {
  protected override async pinDefaultReleaseFeed(): Promise<'ready'> {
    return 'ready'
  }
}

describe('automatic desktop updates', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    autoUpdater.removeAllListeners()
    nativeUpdater.removeAllListeners()
    autoUpdater.checkForUpdates.mockImplementation(async () => {
      autoUpdater.emit('checking-for-update')
      autoUpdater.emit('update-available', { version: '1.1.0' })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stages a background offer and keeps it ready through the next check', async () => {
    const updater = new ReleaseUpdater()
    updater.setupAutoUpdater(null, {
      getAutomaticUpdates: () => true,
      getLastUpdateCheckAt: Date.now
    })

    updater.checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloading', version: '1.1.0' })

    autoUpdater.emit('update-downloaded', { version: '1.1.0', files: [] })
    if (process.platform === 'darwin') {
      expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloading', percent: 100 })
      nativeUpdater.emit('update-downloaded')
    }
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloaded', version: '1.1.0' })
    updater.checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloaded', version: '1.1.0' })
  })

  it('keeps the offer manual until the preference is enabled', async () => {
    let automaticUpdates = false
    const updater = new ReleaseUpdater()
    updater.setupAutoUpdater(null, {
      getAutomaticUpdates: () => automaticUpdates,
      getLastUpdateCheckAt: Date.now
    })

    updater.checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'available', version: '1.1.0' })

    automaticUpdates = true
    updater.applyAutomaticUpdatesSetting()
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloading', version: '1.1.0' })
  })
})
