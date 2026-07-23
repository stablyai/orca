import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appMock,
  autoUpdaterMock,
  nativeUpdaterMock,
  killAllPtyMock,
  recordUpdaterLifecycleMock,
  requestServeUpdateHandoffMock,
  failServeUpdateHandoffMock,
  resetHandlers
} = vi.hoisted(() => {
  const appHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const updaterHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

  const emit = (
    handlers: Map<string, ((...args: unknown[]) => void)[]>,
    event: string,
    ...args: unknown[]
  ): void => {
    for (const handler of handlers.get(event) ?? []) {
      handler(...args)
    }
  }

  const appMock = {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.51'),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appHandlers.set(event, [...(appHandlers.get(event) ?? []), handler])
      return appMock
    }),
    emit: (event: string, ...args: unknown[]) => emit(appHandlers, event, ...args),
    quit: vi.fn()
  }

  const autoUpdaterMock = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: true,
    allowPrerelease: false,
    checkForUpdates: vi.fn().mockResolvedValue(null),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      updaterHandlers.set(event, [...(updaterHandlers.get(event) ?? []), handler])
      return autoUpdaterMock
    }),
    emit: (event: string, ...args: unknown[]) => emit(updaterHandlers, event, ...args)
  }

  return {
    appMock,
    autoUpdaterMock,
    nativeUpdaterMock: { on: vi.fn() },
    killAllPtyMock: vi.fn(),
    recordUpdaterLifecycleMock: vi.fn(),
    requestServeUpdateHandoffMock: vi.fn(() => true),
    failServeUpdateHandoffMock: vi.fn(),
    resetHandlers: () => {
      appHandlers.clear()
      updaterHandlers.clear()
    }
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: vi.fn() },
  shell: { openExternal: vi.fn() },
  net: { fetch: vi.fn() }
}))

vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }))
vi.mock('./electron-updater-loader', () => ({ loadElectronAutoUpdater: () => autoUpdaterMock }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./ipc/pty', () => ({ killAllPty: killAllPtyMock }))
vi.mock('./updater-changelog', () => ({ fetchChangelog: vi.fn().mockResolvedValue(null) }))
vi.mock('./updater-nudge', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))
vi.mock('./updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: vi.fn().mockResolvedValue({
    tags: ['v1.0.61'],
    state: 'ready'
  }),
  getReleaseDownloadUrl: vi.fn()
}))
vi.mock('./update-install-exit-watchdog', () => ({
  armUpdateInstallExitWatchdog: vi.fn(),
  disarmUpdateInstallExitWatchdog: vi.fn()
}))
vi.mock('./updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))
vi.mock('./serve-update-handoff', () => ({
  failServeUpdateHandoff: failServeUpdateHandoffMock,
  getServeUpdateHandoffFailure: vi.fn(() => null),
  hasServeUpdateSupervisor: vi.fn(() => true),
  requestServeUpdateHandoff: requestServeUpdateHandoffMock
}))

describe('headless serve update install handoff', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null)
    autoUpdaterMock.downloadUpdate.mockReset().mockResolvedValue([])
    autoUpdaterMock.quitAndInstall.mockReset()
    autoUpdaterMock.setFeedURL.mockReset()
    autoUpdaterMock.on.mockClear()
    autoUpdaterMock.autoInstallOnAppQuit = false
    autoUpdaterMock.autoRunAppAfterInstall = true
    nativeUpdaterMock.on.mockReset()
    appMock.on.mockClear()
    appMock.quit.mockReset()
    killAllPtyMock.mockReset()
    recordUpdaterLifecycleMock.mockReset()
    requestServeUpdateHandoffMock.mockReset().mockReturnValue(true)
    failServeUpdateHandoffMock.mockReset()
    resetHandlers()
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

    const { checkForUpdatesFromMenu, quitAndInstall, setupAutoUpdater } = await import('./updater')
    setupAutoUpdater(
      { webContents: { send } } as never,
      {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'unsupported-headless-serve'
      } as never
    )

    checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
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

    const { checkForUpdatesFromMenu, downloadUpdate, setupAutoUpdater } = await import('./updater')
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

  it('hands a supervised install to the serve parent before native quit and cleanup', async () => {
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
      await import('./updater')
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
  })

  it('keeps the serving owner intact when the supervisor handoff cannot be persisted', async () => {
    const send = vi.fn()
    requestServeUpdateHandoffMock.mockReturnValue(false)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
      return Promise.resolve(null)
    })

    const { checkForUpdatesFromMenu, quitAndInstall, setupAutoUpdater } = await import('./updater')
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
  })

  it.runIf(process.platform === 'darwin')(
    'defers a pre-staged macOS update resumed from the native-ready continuation',
    async () => {
      const send = vi.fn()
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(null)
      })

      const { checkForUpdatesFromMenu, setupAutoUpdater } = await import('./updater')
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

      const { checkForUpdatesFromMenu, setupAutoUpdater } = await import('./updater')
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
        await import('./updater')
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
    } = await import('./updater')
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
      await import('./updater')
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
})
