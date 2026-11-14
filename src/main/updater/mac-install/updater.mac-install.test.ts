import type { getReleaseDownloadUrl } from '../releases/updater-release-readiness'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ServeSupervisorInstallPark from '../lifecycle/serve-supervisor-install-park'
import { loadUpdaterModule, warmUpdaterModule } from '../testing/updater-test-module-loader'
import { updaterMainWindow } from '../testing/updater-test-main-window'

const {
  appMock,
  browserWindowMock,
  nativeUpdaterMock,
  autoUpdaterMock,
  shellMock,
  killAllPtyMock,
  getMacUpdateRunningInstancesMock,
  prepareShipItStagingMock,
  recoverBrowserSidecarsMock,
  describeBrowserBlockersMock
} = vi.hoisted(() => {
  const appEventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

  const appOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = appEventHandlers.get(event) ?? []
    handlers.push(handler)
    appEventHandlers.set(event, handlers)
    return appMock
  })

  const appEmit = (event: string, ...args: unknown[]) => {
    for (const handler of appEventHandlers.get(event) ?? []) {
      handler(...args)
    }
  }

  const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = eventHandlers.get(event) ?? []
    handlers.push(handler)
    eventHandlers.set(event, handlers)
    return autoUpdaterMock
  })

  const emit = (event: string, ...args: unknown[]) => {
    for (const handler of eventHandlers.get(event) ?? []) {
      handler(...args)
    }
  }

  const reset = () => {
    appEventHandlers.clear()
    appOn.mockClear()
    eventHandlers.clear()
    on.mockClear()
    autoUpdaterMock.checkForUpdates.mockReset()
    autoUpdaterMock.downloadUpdate.mockReset()
    autoUpdaterMock.quitAndInstall.mockReset()
  }

  const autoUpdaterMock = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    emit,
    reset
  }

  return {
    appMock: {
      isPackaged: true,
      getVersion: vi.fn(() => '1.0.51'),
      on: appOn,
      prependListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        appEventHandlers.set(event, [handler, ...(appEventHandlers.get(event) ?? [])])
      }),
      emit: appEmit,
      quit: vi.fn()
    },
    browserWindowMock: {
      getAllWindows: vi.fn(() => [])
    },
    nativeUpdaterMock: {
      on: vi.fn()
    },
    autoUpdaterMock,
    shellMock: {
      openExternal: vi.fn()
    },

    getMacUpdateRunningInstancesMock: vi.fn(async (): Promise<number[]> => []),
    recoverBrowserSidecarsMock: vi.fn(async (_executable: string, pids: number[]) => pids),
    describeBrowserBlockersMock: vi.fn(async (_executable: string, pids: number[]) =>
      pids.map((pid) => ({ pid, kind: 'unknown' as const }))
    ),
    prepareShipItStagingMock: vi.fn((): Promise<void> | null => null),
    killAllPtyMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: vi.fn() },
  shell: shellMock,
  net: { fetch: vi.fn() }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock
}))

vi.mock('../releases/updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: vi
    .fn()
    .mockResolvedValue({ tags: ['v1.4.241'], state: 'ready' }),
  getReleaseDownloadUrl: (tag: string) =>
    `https://github.com/stablyai/orca/releases/download/${tag}`
}))
vi.mock('../releases/updater-release-readiness', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReleaseDownloadUrl: (
    await vi.importMock<{
      getReleaseDownloadUrl: typeof getReleaseDownloadUrl
    }>('../releases/updater-prerelease-feed')
  ).getReleaseDownloadUrl
}))

vi.mock('../electron-updater-loader', () => ({
  loadElectronAutoUpdater: () => autoUpdaterMock
}))

vi.mock('../../ipc/pty/kill-all', () => ({ killAllPty: killAllPtyMock }))

vi.mock('../releases/updater-changelog', () => ({
  fetchChangelog: vi.fn().mockResolvedValue(null)
}))

vi.mock('../nudges/nudge-campaign', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))

vi.mock('./shipit-leftover-recovery', () => ({
  prepareThisProcessShipItStaging: prepareShipItStagingMock
}))

vi.mock('./macos-update-running-instances', () => ({
  getMacUpdateRunningInstances: getMacUpdateRunningInstancesMock
}))

vi.mock('./mac-browser-sidecar-recovery', () => ({
  recoverMacBrowserSidecars: recoverBrowserSidecarsMock,
  describeMacUpdateBlockers: describeBrowserBlockersMock
}))

// No serve supervisors are registered, so every blocker is refused.
vi.mock('../lifecycle/serve-supervisor-install-park', async (importOriginal) => ({
  ...(await importOriginal<typeof ServeSupervisorInstallPark>()),
  parkServeSupervisorsForInstall: (_executable: string, blockers: number[]) => ({
    kind: 'refused',
    reason: 'unregistered',
    pids: blockers
  }),
  commitServeSupervisorPark: async () => undefined,
  releaseServeSupervisorPark: async () => undefined
}))

warmUpdaterModule()

async function prepareStagedMacUpdate(downloadUpdate: () => void): Promise<void> {
  await vi.waitFor(() => expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1))
  autoUpdaterMock.emit('checking-for-update')
  autoUpdaterMock.emit('update-available', { version: '1.0.61' })
  await vi.advanceTimersByTimeAsync(0)
  downloadUpdate()
  autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })
  const nativeReady = nativeUpdaterMock.on.mock.calls.find(
    ([event]) => event === 'update-downloaded'
  )?.[1]
  nativeReady?.()
}

describe('updater mac install handoff', () => {
  beforeEach(() => {
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    shellMock.openExternal.mockReset()
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.quit.mockReset()
    appMock.isPackaged = true

    killAllPtyMock.mockReset()
    getMacUpdateRunningInstancesMock.mockReset().mockResolvedValue([])
    recoverBrowserSidecarsMock
      .mockReset()
      .mockImplementation(async (_executable: string, pids: number[]) => pids)
    describeBrowserBlockersMock
      .mockReset()
      .mockImplementation(async (_executable: string, pids: number[]) =>
        pids.map((pid) => ({ pid, kind: 'unknown' as const }))
      )
    prepareShipItStagingMock.mockReset().mockReturnValue(null)
    autoUpdaterMock.downloadUpdate.mockResolvedValue([])
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.runIf(process.platform === 'darwin')(
    'ignores duplicate quit requests while deferred mac install cleanup is running',
    async () => {
      vi.useFakeTimers()

      let finishCleanup!: () => void
      const onBeforeQuit = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCleanup = resolve
          })
      )
      const mainWindow = updaterMainWindow(vi.fn())

      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      const { setupAutoUpdater, downloadUpdate, quitAndInstall } = await loadUpdaterModule()

      setupAutoUpdater(mainWindow, { onBeforeQuit })
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      autoUpdaterMock.emit('checking-for-update')
      autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      await vi.advanceTimersByTimeAsync(0)
      downloadUpdate()
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      quitAndInstall()
      const preventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault })
      expect(preventDefault).toHaveBeenCalledTimes(1)

      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      expect(nativeDownloadedHandler).toBeTypeOf('function')

      nativeDownloadedHandler?.()
      await vi.advanceTimersByTimeAsync(0)

      expect(onBeforeQuit).toHaveBeenCalledTimes(1)
      expect(getMacUpdateRunningInstancesMock).toHaveBeenCalledOnce()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

      quitAndInstall()
      finishCleanup()
      await vi.advanceTimersByTimeAsync(0)

      expect(onBeforeQuit).toHaveBeenCalledTimes(1)
      expect(killAllPtyMock).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    }
  )

  it.runIf(process.platform === 'darwin')(
    'keeps the app and terminals open when another bundle instance blocks installation, then allows retry',
    async () => {
      vi.useFakeTimers()
      const send = vi.fn()
      const onBeforeQuit = vi.fn()
      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      const { setupAutoUpdater, downloadUpdate, quitAndInstall, isQuittingForUpdate } =
        await loadUpdaterModule()
      setupAutoUpdater(updaterMainWindow(send), { onBeforeQuit })
      await prepareStagedMacUpdate(downloadUpdate)
      getMacUpdateRunningInstancesMock.mockResolvedValue([9654, 10718])
      let finishDescription: () => void = () => undefined
      describeBrowserBlockersMock.mockImplementationOnce(async (_executable, pids) => {
        await new Promise<void>((resolve) => {
          finishDescription = resolve
        })
        return pids.map((pid) => ({ pid, kind: 'unknown' as const }))
      })

      quitAndInstall()
      await vi.advanceTimersByTimeAsync(1000)
      expect(describeBrowserBlockersMock).toHaveBeenCalledOnce()
      expect(isQuittingForUpdate()).toBe(true)
      expect(send).not.toHaveBeenCalledWith('updater:quitAndInstallAborted')
      const probeCount = getMacUpdateRunningInstancesMock.mock.calls.length
      quitAndInstall()
      await vi.advanceTimersByTimeAsync(1000)
      expect(getMacUpdateRunningInstancesMock).toHaveBeenCalledTimes(probeCount)
      finishDescription()
      await vi.advanceTimersByTimeAsync(0)

      expect(onBeforeQuit).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(isQuittingForUpdate()).toBe(false)
      expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          message: expect.stringContaining('9654, 10718'),
          retryAction: 'install',
          installBlock: {
            reason: 'running-instances',
            instances: [
              { pid: 9654, kind: 'unknown' },
              { pid: 10718, kind: 'unknown' }
            ]
          }
        })
      )

      getMacUpdateRunningInstancesMock.mockResolvedValue([])
      quitAndInstall()
      await vi.advanceTimersByTimeAsync(1000)
      expect(onBeforeQuit).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    }
  )

  it.runIf(process.platform === 'darwin')(
    'keeps the install target and quit guard when checks or downloads are requested during a retry',
    async () => {
      vi.useFakeTimers()
      autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
      const {
        setupAutoUpdater,
        downloadUpdate,
        quitAndInstall,
        checkForUpdates,
        checkForUpdatesFromMenu,
        getUpdateStatus
      } = await loadUpdaterModule()
      setupAutoUpdater(updaterMainWindow(vi.fn()))
      await prepareStagedMacUpdate(downloadUpdate)
      getMacUpdateRunningInstancesMock.mockResolvedValue([9654])
      quitAndInstall()
      await vi.advanceTimersByTimeAsync(1000)
      let finishProbe = (_pids: number[]): void => {}
      getMacUpdateRunningInstancesMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishProbe = resolve
          })
      )
      const checks = autoUpdaterMock.checkForUpdates.mock.calls.length
      const downloads = autoUpdaterMock.downloadUpdate.mock.calls.length
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        return Promise.resolve(undefined)
      })
      const requestCompetingActions = (): void => {
        checkForUpdatesFromMenu()
        checkForUpdatesFromMenu({ localBuild: true })
        checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.0.70' })
        checkForUpdates()
        downloadUpdate()
      }
      quitAndInstall()
      requestCompetingActions()
      await vi.advanceTimersByTimeAsync(1000)
      requestCompetingActions()
      await vi.advanceTimersByTimeAsync(0)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(checks)
      expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(downloads)
      expect(getUpdateStatus()).toEqual({
        state: 'downloaded',
        version: '1.0.61',
        installing: true
      })
      const preventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
      finishProbe([])
      await vi.advanceTimersByTimeAsync(0)
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce()
    }
  )
})
