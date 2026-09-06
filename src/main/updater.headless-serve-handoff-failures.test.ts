import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SHA512,
  SERVE_UPDATE_VERDICT_POLL_MS,
  resetHeadlessServeHarness,
  setupHeadlessServeTestHarness
} from './updater-headless-serve-test-setup'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const harness = setupHeadlessServeTestHarness()

warmUpdaterModule()

describe('headless serve update handoff failure paths', () => {
  beforeEach(() => {
    resetHeadlessServeHarness(harness)
  })

  it.skipIf(process.platform !== 'linux')(
    'cancels the helper via the spool when the quit-fence census blocks the update',
    async () => {
      const send = vi.fn()
      harness.captureServeUpdateAppImageMock.mockResolvedValue({
        ok: true,
        artifact: {
          artifactPath: '/downloads/orca-1.0.61.AppImage',
          sha512: SHA512,
          targetVersion: '1.0.61'
        }
      })
      harness.readServeUpdateResultForMock.mockReturnValue({
        verdict: 'accepted',
        message: ''
      })
      harness.autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        harness.autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() =>
          harness.autoUpdaterMock.emit('update-available', { version: '1.0.61' })
        )
        return Promise.resolve(null)
      })

      const updaterModule = await loadUpdaterModule()
      // A census listing without a complete host scope blocks the quit fence.
      updaterModule.setServeUpdateCensusRuntime({
        listTerminals: async () => ({})
      } as never)
      const {
        checkForUpdatesFromMenu,
        downloadUpdate,
        quitAndInstall,
        setServeUpdateRuntimeId,
        setupAutoUpdater
      } = updaterModule
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'supervised-headless-serve'
      })
      setServeUpdateRuntimeId('rt-42')

      checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      downloadUpdate()
      harness.autoUpdaterMock.emit('update-downloaded', {
        version: '1.0.61',
        downloadedFile: '/downloads/orca-1.0.61.AppImage',
        files: [{ url: 'orca-1.0.61.AppImage', sha512: SHA512 }]
      })

      quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)

      expect(harness.appMock.quit).not.toHaveBeenCalled()
      expect(harness.killAllPtyMock).not.toHaveBeenCalled()
      // No continuation: the waiting helper sees the cleared request and aborts.
      expect(harness.writeServeUpdateCensusContinuationMock).not.toHaveBeenCalled()
      expect(harness.clearUpdateRequestMock).toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          message: expect.stringContaining('live terminals')
        })
      )
      updaterModule.setServeUpdateCensusRuntime(null)
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'stays alive with the real reason when the helper cannot be spawned',
    async () => {
      const send = vi.fn()
      harness.captureServeUpdateAppImageMock.mockResolvedValue({
        ok: true,
        artifact: {
          artifactPath: '/downloads/orca-1.0.61.AppImage',
          sha512: SHA512,
          targetVersion: '1.0.61'
        }
      })
      harness.readServeUpdateResultForMock.mockReturnValue(null)
      harness.runProcessMock.mockRejectedValue(new Error('sudo_not_found'))
      harness.autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        harness.autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() =>
          harness.autoUpdaterMock.emit('update-available', { version: '1.0.61' })
        )
        return Promise.resolve(null)
      })

      const {
        checkForUpdatesFromMenu,
        downloadUpdate,
        quitAndInstall,
        setServeUpdateRuntimeId,
        setupAutoUpdater
      } = await loadUpdaterModule()
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'supervised-headless-serve'
      })
      setServeUpdateRuntimeId('rt-42')

      checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      downloadUpdate()
      harness.autoUpdaterMock.emit('update-downloaded', {
        version: '1.0.61',
        downloadedFile: '/downloads/orca-1.0.61.AppImage',
        files: [{ url: 'orca-1.0.61.AppImage', sha512: SHA512 }]
      })

      quitAndInstall()
      // One poll interval is enough for the spawn rejection to abort the verdict poll.
      await vi.advanceTimersByTimeAsync(SERVE_UPDATE_VERDICT_POLL_MS + 100)

      expect(harness.appMock.quit).not.toHaveBeenCalled()
      expect(harness.killAllPtyMock).not.toHaveBeenCalled()
      expect(harness.clearUpdateRequestMock).toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          message: expect.stringContaining('Could not launch the server update helper')
        })
      )
      expect(harness.recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'headless_serve_update_not_accepted',
        { version: '1.0.61', reason: 'sudo_not_found' },
        expect.objectContaining({ level: 'warn' })
      )
    }
  )
})
