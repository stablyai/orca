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

  it.skipIf(process.platform !== 'linux')(
    'stays alive when the helper runs but exits nonzero',
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
      // A resolved nonzero exit (not a rejection): the helper ran and failed.
      harness.runProcessMock.mockResolvedValue({
        code: 3,
        stdout: '',
        stderr: 'boom',
        timedOut: false
      })
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
        { version: '1.0.61', reason: 'helper-exit-3: boom' },
        expect.objectContaining({ level: 'warn' })
      )
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'stays alive with the helper message when the verdict is rejected',
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
        verdict: 'rejected',
        message: 'downgrade refused: 1.0.51 >= 1.0.61'
      })
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
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(SERVE_UPDATE_VERDICT_POLL_MS + 100)

      expect(harness.appMock.quit).not.toHaveBeenCalled()
      expect(harness.killAllPtyMock).not.toHaveBeenCalled()
      expect(harness.writeServeUpdateCensusContinuationMock).not.toHaveBeenCalled()
      expect(harness.clearUpdateRequestMock).toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          message: expect.stringContaining('downgrade refused')
        })
      )
      expect(harness.recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'headless_serve_update_not_accepted',
        { version: '1.0.61' },
        expect.objectContaining({ level: 'warn' })
      )
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'stays alive with the helper message when the verdict is failed',
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
        verdict: 'failed',
        message: 'systemctl stop failed'
      })
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
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(SERVE_UPDATE_VERDICT_POLL_MS + 100)

      expect(harness.appMock.quit).not.toHaveBeenCalled()
      expect(harness.killAllPtyMock).not.toHaveBeenCalled()
      expect(harness.clearUpdateRequestMock).toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          message: expect.stringContaining('systemctl stop failed')
        })
      )
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'stays alive when the downloaded artifact fails verification',
    async () => {
      const send = vi.fn()
      harness.captureServeUpdateAppImageMock.mockResolvedValue({
        ok: false,
        reason: 'hash-mismatch'
      })
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
      await vi.advanceTimersByTimeAsync(100)

      expect(harness.writeUpdateRequestMock).not.toHaveBeenCalled()
      expect(harness.readServeUpdateResultForMock).not.toHaveBeenCalled()
      expect(harness.appMock.quit).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          message: expect.stringContaining('failed verification')
        })
      )
      expect(harness.recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'headless_serve_handoff_failed',
        { version: '1.0.61', reason: 'artifact-hash-mismatch' },
        expect.objectContaining({ level: 'warn' })
      )
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'stays alive when the update request cannot be spooled',
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
      harness.writeUpdateRequestMock.mockReturnValue(false)
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
      await vi.advanceTimersByTimeAsync(100)

      expect(harness.readServeUpdateResultForMock).not.toHaveBeenCalled()
      expect(harness.appMock.quit).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          message: expect.stringContaining('Could not hand the update to the server supervisor')
        })
      )
      expect(harness.recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'headless_serve_handoff_failed',
        { version: '1.0.61', reason: 'spool-write-failed' },
        expect.objectContaining({ level: 'warn' })
      )
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'stays alive when a retried install finds no download left to spool',
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

      // First attempt consumes the download info and fails fast at the helper spawn.
      quitAndInstall()
      await vi.advanceTimersByTimeAsync(SERVE_UPDATE_VERDICT_POLL_MS + 100)
      // A retried install has no download metadata left: it must fail cleanly, not crash.
      quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)

      expect(harness.appMock.quit).not.toHaveBeenCalled()
      expect(harness.writeUpdateRequestMock).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          message: expect.stringContaining('Could not verify the downloaded update')
        })
      )
      expect(harness.recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'headless_serve_handoff_failed',
        { version: '1.0.61', reason: 'missing-download-metadata' },
        expect.objectContaining({ level: 'warn' })
      )
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'rejects the install RPC when the census gate blocks it',
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
      updaterModule.setServeUpdateCensusGate(() =>
        Promise.resolve({ ok: false, reason: 'terminals-live' })
      )
      const { checkForUpdatesFromMenu, downloadUpdate, setServeUpdateRuntimeId, setupAutoUpdater } =
        updaterModule
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
      await vi.advanceTimersByTimeAsync(0)

      await expect(updaterModule.installRemoteServerUpdate('rt-1')).rejects.toThrow(
        'remote_update_live_terminals'
      )

      expect(harness.appMock.quit).not.toHaveBeenCalled()
      expect(harness.writeUpdateRequestMock).not.toHaveBeenCalled()
      expect(harness.killAllPtyMock).not.toHaveBeenCalled()
      expect(harness.recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'headless_serve_update_census_blocked',
        { reason: 'terminals-live' },
        expect.objectContaining({ level: 'warn' })
      )
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'runs the armed quit-fence census before authorizing the helper',
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
      const listTerminals = vi.fn(async () => ({
        terminals: [],
        totalCount: 0,
        hostScope: { hostIds: ['local'], omittedHostIds: [] }
      }))
      harness.autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        harness.autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() =>
          harness.autoUpdaterMock.emit('update-available', { version: '1.0.61' })
        )
        return Promise.resolve(null)
      })

      const updaterModule = await loadUpdaterModule()
      updaterModule.setServeUpdateCensusRuntime({ listTerminals } as never)
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
      await vi.advanceTimersByTimeAsync(SERVE_UPDATE_VERDICT_POLL_MS + 100)

      // The fence re-consulted the census as close to the quit as it can get.
      expect(listTerminals).toHaveBeenCalledWith(undefined, 1, {
        requireFreshPtyLiveness: true,
        includeVisualLayouts: false
      })
      expect(harness.writeServeUpdateCensusContinuationMock).toHaveBeenCalled()
      expect(harness.killAllPtyMock).toHaveBeenCalled()
      expect(harness.appMock.quit).toHaveBeenCalled()
    }
  )
})
