import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdaterSetup } from './updater-setup'
import { updaterMainWindow } from '../testing/updater-test-main-window'

const { autoUpdater, nativeUpdater, prepareRendererForUpdate } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return {
    autoUpdater: Object.assign(new EventEmitter(), {
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn<() => Promise<unknown>>(),
      downloadUpdate: vi.fn(async () => []),
      quitAndInstall: vi.fn()
    }),
    nativeUpdater: new EventEmitter(),
    prepareRendererForUpdate: vi.fn<() => Promise<(() => void) | null>>()
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
vi.mock('../../window/renderer-relays/native-unload-coordinator', () => ({
  prepareRendererForUpdate
}))
vi.mock('./updater-installer-session-release', () => ({ releaseSessionsForInstaller: () => 0 }))
vi.mock('../updater-lifecycle-diagnostics', () => ({ recordUpdaterLifecycle: vi.fn() }))
vi.mock('../../cli/appimage/appimage-copy-pre-extraction', () => ({
  preExtractDownloadedAppImageUpdate: async () => false
}))

class ReleaseUpdater extends UpdaterSetup {
  protected override async pinDefaultReleaseFeed(): Promise<'ready'> {
    return 'ready'
  }

  protected override async preflightMacInstall(): Promise<boolean> {
    return true
  }
}

function finishDownload(): void {
  autoUpdater.emit('update-downloaded', { version: '1.1.0', files: [] })
  if (process.platform === 'darwin') {
    nativeUpdater.emit('update-downloaded')
  }
}

describe('automatic desktop updates', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    autoUpdater.removeAllListeners()
    nativeUpdater.removeAllListeners()
    autoUpdater.quitAndInstall.mockClear()
    prepareRendererForUpdate.mockReset().mockResolvedValue(() => {})
    autoUpdater.checkForUpdates.mockImplementation(async () => {
      autoUpdater.emit('checking-for-update')
      autoUpdater.emit('update-available', { version: '1.1.0' })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('installs an eligible background update after the renderer has saved its state', async () => {
    const updater = new ReleaseUpdater()
    let finishCheckpoint!: (cancel: () => void) => void
    prepareRendererForUpdate.mockReturnValue(
      new Promise((resolve) => {
        finishCheckpoint = resolve
      })
    )
    updater.setupAutoUpdater(
      updaterMainWindow(() => {}),
      {
        getAutomaticUpdates: () => true,
        getLastUpdateCheckAt: Date.now
      }
    )

    updater.checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloading', version: '1.1.0' })

    autoUpdater.emit('update-downloaded', { version: '1.1.0', files: [] })
    if (process.platform === 'darwin') {
      expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloading', percent: 100 })
      expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
      nativeUpdater.emit('update-downloaded')
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(updater.getUpdateStatus()).toMatchObject({
      state: 'downloaded',
      version: '1.1.0',
      installing: true
    })
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()

    finishCheckpoint(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('keeps the update ready when the user opts out during the download', async () => {
    let automaticUpdates = true
    const updater = new ReleaseUpdater()
    updater.setupAutoUpdater(null, {
      getAutomaticUpdates: () => automaticUpdates,
      getLastUpdateCheckAt: Date.now
    })

    updater.checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)
    automaticUpdates = false
    finishDownload()
    await vi.advanceTimersByTimeAsync(1000)

    expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloaded', version: '1.1.0' })
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('leaves Orca running if it cannot save renderer state', async () => {
    prepareRendererForUpdate.mockResolvedValue(null)
    const updater = new ReleaseUpdater()
    updater.setupAutoUpdater(
      updaterMainWindow(() => {}),
      {
        getAutomaticUpdates: () => true,
        getLastUpdateCheckAt: Date.now
      }
    )

    updater.checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)
    finishDownload()
    await vi.advanceTimersByTimeAsync(1000)

    expect(updater.getUpdateStatus()).toMatchObject({
      state: 'error',
      version: '1.1.0',
      retryAction: 'install'
    })
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
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
