import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SHA512,
  resetHeadlessServeHarness,
  setupHeadlessServeTestHarness
} from './updater-headless-serve-test-setup'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const {
  appMock,
  autoUpdaterMock,
  nativeUpdaterMock,
  killAllPtyMock,
  recordUpdaterLifecycleMock,
  requestServeUpdateHandoffMock,
  failServeUpdateHandoffMock,
  hasServeUpdateSupervisorMock,
  writeUpdateRequestMock,
  clearUpdateRequestMock,
  clearUpdateResultMock,
  readServeUpdateResultForMock,
  writeServeUpdateCensusContinuationMock,
  clearServeUpdateCensusContinuationMock,
  captureServeUpdateAppImageMock,
  runProcessMock,
  resetHandlers
} = setupHeadlessServeTestHarness()

warmUpdaterModule()

describe('headless serve update install handoff', () => {
  beforeEach(() => {
    resetHeadlessServeHarness({
      appMock,
      autoUpdaterMock,
      nativeUpdaterMock,
      killAllPtyMock,
      recordUpdaterLifecycleMock,
      requestServeUpdateHandoffMock,
      failServeUpdateHandoffMock,
      hasServeUpdateSupervisorMock,
      writeUpdateRequestMock,
      clearUpdateRequestMock,
      clearUpdateResultMock,
      readServeUpdateResultForMock,
      writeServeUpdateCensusContinuationMock,
      clearServeUpdateCensusContinuationMock,
      captureServeUpdateAppImageMock,
      runProcessMock,
      resetHandlers
    })
  })

  it('defers install before disconnecting the serving owner or starting session cleanup', async () => {
    const lifecycle: string[] = []
    const pendingInstaller = { version: '1.0.61', staged: true }
    const servingOwner = { version: '1.0.51', connectedClients: 2, verified: true }
    const replacementOwner: { version: string; verified: boolean } | null = null
    const send = vi.fn()
    const beginSessionCleanup = vi.fn(() => lifecycle.push('session-cleanup'))
    const disconnectPairedClients = vi.fn(() => {
      lifecycle.push('paired-clients-disconnected')
      servingOwner.connectedClients = 0
      servingOwner.verified = false
    })

    appMock.on('will-quit', disconnectPairedClients)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: pendingInstaller.version })
      })
      return Promise.resolve(null)
    })
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      lifecycle.push('native-quit-and-install')
      appMock.emit('will-quit', { preventDefault: vi.fn() })
    })
    killAllPtyMock.mockImplementation(beginSessionCleanup)

    const { checkForUpdatesFromMenu, quitAndInstall, setupAutoUpdater } = await loadUpdaterModule()
    setupAutoUpdater(
      { webContents: { send } } as never,
      {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'unsupported-headless-serve'
      } as never
    )

    checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    autoUpdaterMock.emit('download-progress', { percent: 100 })
    autoUpdaterMock.emit('update-downloaded', { version: pendingInstaller.version })
    const nativeReadyHandler = nativeUpdaterMock.on.mock.calls.find(
      ([event]) => event === 'update-downloaded'
    )?.[1] as (() => void) | undefined
    nativeReadyHandler?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'downloaded', version: pendingInstaller.version })
    )

    quitAndInstall()
    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)
    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    const statuses = send.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect({
      nativeInstallCalls: autoUpdaterMock.quitAndInstall.mock.calls.length,
      pairedClientDisconnects: disconnectPairedClients.mock.calls.length,
      sessionCleanupStarts: beginSessionCleanup.mock.calls.length,
      servingOwner,
      replacementOwner,
      pendingInstaller,
      deferredStatusVisible: statuses.some(
        (status) =>
          status &&
          typeof status === 'object' &&
          'state' in status &&
          status.state === 'error' &&
          'message' in status &&
          typeof status.message === 'string' &&
          status.message.includes('orca serve')
      ),
      deferralDiagnostics: recordUpdaterLifecycleMock.mock.calls.filter(
        ([event]) => event === 'headless_serve_install_deferred'
      ).length,
      lifecycle
    }).toEqual({
      nativeInstallCalls: 0,
      pairedClientDisconnects: 0,
      sessionCleanupStarts: 0,
      servingOwner: { version: '1.0.51', connectedClients: 2, verified: true },
      replacementOwner: null,
      pendingInstaller: { version: '1.0.61', staged: true },
      deferredStatusVisible: true,
      deferralDiagnostics: 1,
      lifecycle: []
    })
  })

  it('blocks staging and install-on-quit while still reporting an available update', async () => {
    const send = vi.fn()
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
      return Promise.resolve(null)
    })

    const { checkForUpdatesFromMenu, downloadUpdate, setupAutoUpdater } = await loadUpdaterModule()
    setupAutoUpdater({ webContents: { send } } as never, {
      getLastUpdateCheckAt: () => Date.now(),
      installMode: 'unsupported-headless-serve'
    })
    checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.61' })
    )

    downloadUpdate()
    downloadUpdate()

    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
    expect(
      recordUpdaterLifecycleMock.mock.calls.filter(
        ([event, data]) =>
          event === 'headless_serve_install_deferred' &&
          data &&
          typeof data === 'object' &&
          'phase' in data &&
          data.phase === 'download'
      )
    ).toHaveLength(1)
    expect(
      send.mock.calls.filter(
        ([channel, status]) => channel === 'updater:status' && status?.state === 'error'
      )
    ).toHaveLength(1)
  })

  it.skipIf(process.platform !== 'darwin')(
    'hands a supervised install to the serve parent before native quit and cleanup',
    async () => {
      const lifecycle: string[] = []
      const daemonSession = { alive: true }
      const send = vi.fn()
      const disconnectPairedClients = vi.fn(() => lifecycle.push('paired-clients-disconnected'))
      appMock.on('will-quit', disconnectPairedClients)
      requestServeUpdateHandoffMock.mockImplementation(() => {
        lifecycle.push('handoff-persisted')
        return true
      })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(null)
      })
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        lifecycle.push('native-quit-and-install')
        appMock.emit('will-quit', { preventDefault: vi.fn() })
      })
      killAllPtyMock.mockImplementation(() => lifecycle.push('in-process-pty-cleanup'))

      const { checkForUpdatesFromMenu, downloadUpdate, quitAndInstall, setupAutoUpdater } =
        await loadUpdaterModule()
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'supervised-headless-serve',
        onBeforeQuit: () => {
          lifecycle.push('pre-quit-checkpoint')
        }
      })
      checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      downloadUpdate()
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })
      const nativeReadyHandler = nativeUpdaterMock.on.mock.calls.find(
        ([event]) => event === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      nativeReadyHandler?.()

      quitAndInstall()
      quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      quitAndInstall()

      expect(requestServeUpdateHandoffMock).toHaveBeenCalledWith('1.0.61')
      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
      expect(autoUpdaterMock.autoRunAppAfterInstall).toBe(false)
      expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledOnce()
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(true, false)
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce()
      expect(daemonSession).toEqual({ alive: true })
      expect(lifecycle).toEqual([
        'pre-quit-checkpoint',
        'handoff-persisted',
        'native-quit-and-install',
        'paired-clients-disconnected',
        'in-process-pty-cleanup'
      ])
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'keeps the serving owner intact when the supervisor handoff cannot be persisted',
    async () => {
      const send = vi.fn()
      requestServeUpdateHandoffMock.mockReturnValue(false)
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(null)
      })

      const { checkForUpdatesFromMenu, quitAndInstall, setupAutoUpdater } =
        await loadUpdaterModule()
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'supervised-headless-serve'
      })
      checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })
      const nativeReadyHandler = nativeUpdaterMock.on.mock.calls.find(
        ([event]) => event === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      nativeReadyHandler?.()

      quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)

      expect(requestServeUpdateHandoffMock).toHaveBeenCalledOnce()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          message: expect.stringContaining('supervised server restart')
        })
      )
    }
  )

  it.runIf(process.platform === 'darwin')(
    'defers a pre-staged macOS update resumed from the native-ready continuation',
    async () => {
      const send = vi.fn()
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(null)
      })

      const { checkForUpdatesFromMenu, setupAutoUpdater } = await loadUpdaterModule()
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'unsupported-headless-serve'
      })
      checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      const { deferMacQuitUntilInstallerReady } = await import('./updater-mac-install')
      expect(
        deferMacQuitUntilInstallerReady(
          { state: 'downloading', percent: 100, version: '1.0.61' },
          true,
          () => '1.0.61',
          send
        )
      ).toBe(true)
      const nativeReadyHandler = nativeUpdaterMock.on.mock.calls.find(
        ([event]) => event === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      nativeReadyHandler?.()
      await vi.advanceTimersByTimeAsync(0)

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'headless_serve_install_deferred',
        { phase: 'install', version: '1.0.61' },
        expect.objectContaining({ level: 'warn' })
      )
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'error', message: expect.stringContaining('orca serve') })
      )
    }
  )

  it.runIf(process.platform === 'darwin')(
    'does not reinterpret an ordinary headless app quit as an update install request',
    async () => {
      const send = vi.fn()
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(null)
      })

      const { checkForUpdatesFromMenu, setupAutoUpdater } = await loadUpdaterModule()
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'unsupported-headless-serve'
      })
      checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      const preventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault })
      await vi.advanceTimersByTimeAsync(15_000)

      expect(preventDefault).not.toHaveBeenCalled()
      expect(appMock.quit).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    }
  )

  it.runIf(process.platform === 'darwin')(
    'defers before the macOS installer-readiness timeout can quit the serving owner',
    async () => {
      const send = vi.fn()
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(null)
      })

      const { checkForUpdatesFromMenu, quitAndInstall, setupAutoUpdater } =
        await loadUpdaterModule()
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'unsupported-headless-serve'
      })
      checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      quitAndInstall()
      await vi.advanceTimersByTimeAsync(15_000)

      expect(appMock.quit).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'error', message: expect.stringContaining('orca serve') })
      )
    }
  )

  it('preserves interactive download and install-on-quit behavior', async () => {
    const send = vi.fn()
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
      return Promise.resolve(null)
    })

    const {
      checkForUpdatesFromMenu,
      downloadUpdate,
      getRemoteServerUpdateSupport,
      setupAutoUpdater
    } = await loadUpdaterModule()
    setupAutoUpdater({ webContents: { send } } as never, {
      getLastUpdateCheckAt: () => Date.now(),
      installMode: 'interactive'
    })
    checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    downloadUpdate()

    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true)
    expect(autoUpdaterMock.autoRunAppAfterInstall).toBe(true)
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(getRemoteServerUpdateSupport()).toEqual({
      installMode: 'interactive',
      automatic: true,
      reason: 'available'
    })
    expect(recordUpdaterLifecycleMock).not.toHaveBeenCalledWith(
      'headless_serve_install_deferred',
      expect.anything(),
      expect.anything()
    )
  })

  it('advertises remote update control only for safely restartable installs', async () => {
    const { checkForRemoteServerUpdate, getRemoteServerUpdateSupport, setupAutoUpdater } =
      await loadUpdaterModule()
    setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
      getLastUpdateCheckAt: () => Date.now(),
      installMode: 'unsupported-headless-serve'
    })

    expect(getRemoteServerUpdateSupport()).toEqual({
      installMode: 'unsupported-headless-serve',
      automatic: false,
      reason: 'manual-service-update-required'
    })
    expect(() => checkForRemoteServerUpdate('runtime-1')).toThrow('remote_update_manual_required')
  })

  it('gates supervised-serve remote control on the Linux serve update supervisor', async () => {
    // Why: the Linux verdict must match what installRemoteServerUpdate accepts — no
    // supervisor means automatic upgrades would terminate the unit with no way back.
    const { getRemoteServerUpdateSupport, setupAutoUpdater } = await loadUpdaterModule()

    hasServeUpdateSupervisorMock.mockReturnValue(false)
    setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
      getLastUpdateCheckAt: () => Date.now(),
      installMode: 'supervised-headless-serve'
    })
    expect(getRemoteServerUpdateSupport()).toEqual({
      installMode: 'supervised-headless-serve',
      automatic: false,
      reason: 'updater-unavailable'
    })

    hasServeUpdateSupervisorMock.mockReturnValue(true)
    expect(getRemoteServerUpdateSupport()).toEqual({
      installMode: 'supervised-headless-serve',
      automatic: true,
      reason: 'available'
    })
  })

  it.skipIf(process.platform !== 'linux')(
    'downloads, spools and quits only after the helper accepts the update',
    async () => {
      const send = vi.fn()
      captureServeUpdateAppImageMock.mockResolvedValue({
        ok: true,
        artifact: {
          artifactPath: '/downloads/orca-1.0.61.AppImage',
          sha512: SHA512,
          targetVersion: '1.0.61'
        }
      })
      readServeUpdateResultForMock.mockReturnValue({
        verdict: 'accepted',
        message: ''
      })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
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
      autoUpdaterMock.emit('update-downloaded', {
        version: '1.0.61',
        downloadedFile: '/downloads/orca-1.0.61.AppImage',
        files: [{ url: 'orca-1.0.61.AppImage', sha512: SHA512 }]
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'downloaded', version: '1.0.61' })
      )

      quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(500)

      expect(captureServeUpdateAppImageMock).toHaveBeenCalledWith(
        expect.objectContaining({ downloadedFile: '/downloads/orca-1.0.61.AppImage' })
      )
      expect(writeUpdateRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          fromVersion: '1.0.51',
          targetVersion: '1.0.61',
          artifactPath: '/downloads/orca-1.0.61.AppImage',
          sha512: SHA512,
          servingPid: process.pid,
          unitName: 'orca-serve.service'
        })
      )
      expect(readServeUpdateResultForMock).toHaveBeenCalledWith('attempt-42', '1.0.61')
      expect(killAllPtyMock).toHaveBeenCalled()
      expect(appMock.quit).toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith('headless_serve_update_accepted', {
        version: '1.0.61'
      })
      // The quit-fence census passed, so the helper was authorized to stop the unit.
      expect(writeServeUpdateCensusContinuationMock).toHaveBeenCalled()
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'stays alive when the helper verdict never arrives',
    async () => {
      const send = vi.fn()
      captureServeUpdateAppImageMock.mockResolvedValue({
        ok: true,
        artifact: {
          artifactPath: '/downloads/orca-1.0.61.AppImage',
          sha512: SHA512,
          targetVersion: '1.0.61'
        }
      })
      readServeUpdateResultForMock.mockReturnValue(null)
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
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
      autoUpdaterMock.emit('update-downloaded', {
        version: '1.0.61',
        downloadedFile: '/downloads/orca-1.0.61.AppImage',
        files: [{ url: 'orca-1.0.61.AppImage', sha512: SHA512 }]
      })

      quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      // The helper has the full verdict window to respond.
      await vi.advanceTimersByTimeAsync(90_000)

      expect(appMock.quit).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(clearUpdateRequestMock).toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          message: expect.stringContaining('The server update did not complete')
        })
      )
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'headless_serve_update_not_accepted',
        { version: '1.0.61' },
        expect.objectContaining({ level: 'warn' })
      )
    }
  )
})
