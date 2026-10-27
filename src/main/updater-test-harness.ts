import { EventEmitter } from 'node:events'
import { afterAll, vi } from 'vitest'
import type { Mock } from 'vitest'
import { clearTrackedRealTimers, trackRealTimers } from './updater-test-timer-tracking'

type UpdaterSpy = Mock<(...args: unknown[]) => unknown>
type LinuxPackageType = 'deb' | 'rpm' | 'non-root' | 'unusable'

type AutoUpdaterMock = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  disableDifferentialDownload: boolean
  logger: { error: (message: unknown) => void } | undefined
  on: Mock<(event: string, handler: (...args: unknown[]) => void) => AutoUpdaterMock>
  checkForUpdates: UpdaterSpy
  downloadUpdate: UpdaterSpy
  quitAndInstall: UpdaterSpy
  setFeedURL: UpdaterSpy
  updateConfigPath: string | undefined
  emit: (event: string, ...args: unknown[]) => void
  reset: () => void
}

type AppMock = {
  isPackaged: boolean
  getVersion: Mock<() => string>
  on: Mock<(event: string, handler: (...args: unknown[]) => void) => AppMock>
  prependListener: Mock<(event: string, handler: (...args: unknown[]) => void) => AppMock>
  emit: (event: string, ...args: unknown[]) => void
  quit: UpdaterSpy
}

type UpdaterModuleFactories = {
  electron: () => {
    app: AppMock
    BrowserWindow: { getAllWindows: Mock<() => unknown[]> }
    autoUpdater: { on: UpdaterSpy }
    powerMonitor: { on: UpdaterSpy }
    shell: { showItemInFolder: UpdaterSpy }
    net: { fetch: UpdaterSpy }
  }
  electronUpdater: () => { autoUpdater: AutoUpdaterMock }
  electronUpdaterLoader: () => { loadElectronAutoUpdater: () => AutoUpdaterMock }
  ptyKillAll: () => { killAllPty: UpdaterSpy }
  linuxUpdatePackageType: () => {
    getLinuxPackageType: Mock<() => LinuxPackageType>
    getLinuxRootPackageType: Mock<() => 'deb' | 'rpm' | null>
    isExternallyManagedLinuxInstall: Mock<() => boolean>
  }
  updaterLifecycleDiagnostics: () => { recordUpdaterLifecycle: UpdaterSpy }
  updaterChangelog: () => { fetchChangelog: UpdaterSpy }
  updaterNudge: () => { fetchNudge: UpdaterSpy; shouldApplyNudge: UpdaterSpy }
  updateInstallExitWatchdog: () => {
    armUpdateInstallExitWatchdog: UpdaterSpy
    disarmUpdateInstallExitWatchdog: UpdaterSpy
  }
  updaterPrereleaseFeed: () => {
    fetchNewerReleaseTagsWithReadiness: (...args: unknown[]) => Promise<unknown>
    fetchLatestStableReleaseTag: () => Promise<string | null>
    getReleaseDownloadUrl: (tag: string) => string
  }
  localBuildSwitch: () => { chooseLocalBuild: UpdaterSpy }
  localBuildFeedServer: () => { startLocalBuildFeed: UpdaterSpy }
}

export type UpdaterMocks = {
  appMock: AppMock
  browserWindowMock: { getAllWindows: Mock<() => unknown[]> }
  nativeUpdaterMock: { on: UpdaterSpy }
  autoUpdaterMock: AutoUpdaterMock
  killAllPtyMock: UpdaterSpy
  powerMonitorOnMock: UpdaterSpy
  getLinuxPackageTypeMock: Mock<() => LinuxPackageType>
  getLinuxRootPackageTypeMock: Mock<() => 'deb' | 'rpm' | null>
  isExternallyManagedLinuxInstallMock: Mock<() => boolean>
  recordUpdaterLifecycleMock: UpdaterSpy
  fetchChangelogMock: UpdaterSpy
  fetchNudgeMock: UpdaterSpy
  shouldApplyNudgeMock: UpdaterSpy
  armExitWatchdogMock: UpdaterSpy
  disarmExitWatchdogMock: UpdaterSpy
  fetchNewerReleaseTagsMock: UpdaterSpy
  fetchLatestStableReleaseTagMock: Mock<() => Promise<string | null>>
  chooseLocalBuildMock: UpdaterSpy
  startLocalBuildFeedMock: UpdaterSpy
  closeLocalBuildFeedMock: UpdaterSpy
  moduleFactories: UpdaterModuleFactories
  resetUpdaterMocks: () => void
}

// Quitting re-stages Squirrel updates on macOS, so restart advice remains useful there.
export const PRE_COMMIT_INSTALL_FAILURE =
  process.platform === 'darwin'
    ? 'Could not restart to install the update. Quit and reopen Orca, then try again.'
    : 'Could not start the update installer. Orca remains open.'

/** Call from an awaited vi.hoisted block so module factories see initialized mocks. */
export function createUpdaterMocks(): UpdaterMocks {
  const appEvents = new EventEmitter()
  const updaterEvents = new EventEmitter()
  const appOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    appEvents.on(event, handler)
    return appMock
  })
  const appPrependListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    appEvents.prependListener(event, handler)
    return appMock
  })
  const appEmit = (event: string, ...args: unknown[]): void => {
    appEvents.emit(event, ...args)
  }
  const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    updaterEvents.on(event, handler)
    return autoUpdaterMock
  })
  const emit = (event: string, ...args: unknown[]): void => {
    updaterEvents.emit(event, ...args)
  }

  // resetModules cannot cancel old timers; fence stale module instances from shared spies.
  let currentGeneration = 0

  const loadGenerationScopedAutoUpdater = (): AutoUpdaterMock => {
    const loadedGeneration = currentGeneration
    return new Proxy(autoUpdaterMock, {
      get(target, property) {
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: raw string|symbol pass-through; the receiver stays the target on purpose.
        const value = Reflect.get(target, property)
        if (loadedGeneration === currentGeneration || typeof value !== 'function') {
          return value
        }
        return () => undefined
      },
      set(target, property, value) {
        return loadedGeneration === currentGeneration ? Reflect.set(target, property, value) : true
      }
    })
  }

  const reset = () => {
    currentGeneration += 1
    appEvents.removeAllListeners()
    appOn.mockClear()
    appPrependListener.mockClear()
    updaterEvents.removeAllListeners()
    on.mockClear()
    autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null)
    autoUpdaterMock.downloadUpdate.mockReset()
    autoUpdaterMock.quitAndInstall.mockReset()
    autoUpdaterMock.setFeedURL.mockClear()
    autoUpdaterMock.updateConfigPath = undefined
    autoUpdaterMock.allowPrerelease = false
    autoUpdaterMock.allowDowngrade = false
    autoUpdaterMock.disableDifferentialDownload = false
    autoUpdaterMock.autoRunAppAfterInstall = true
    autoUpdaterMock.logger = undefined
    delete (autoUpdaterMock as Record<string, unknown>).verifyUpdateCodeSignature
  }

  const autoUpdaterMock: AutoUpdaterMock = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: true,
    allowPrerelease: false,
    allowDowngrade: false,
    disableDifferentialDownload: false,
    logger: undefined as { error: (message: unknown) => void } | undefined,
    on,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    updateConfigPath: undefined as string | undefined,
    emit,
    reset
  }

  const appMock: AppMock = {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.51'),
    on: appOn,
    prependListener: appPrependListener,
    emit: appEmit,
    quit: vi.fn()
  }
  const browserWindowMock = {
    getAllWindows: vi.fn(() => [])
  }
  const nativeUpdaterMock = {
    on: vi.fn()
  }
  const killAllPtyMock = vi.fn()
  const powerMonitorOnMock = vi.fn()
  const getLinuxRootPackageTypeMock = vi.fn<() => 'deb' | 'rpm' | null>(() => null)
  const getLinuxPackageTypeMock = vi.fn<() => LinuxPackageType>(() => {
    return getLinuxRootPackageTypeMock() ?? 'non-root'
  })
  const isExternallyManagedLinuxInstallMock = vi.fn<() => boolean>(() => false)
  const recordUpdaterLifecycleMock = vi.fn()
  const fetchChangelogMock = vi.fn()
  const fetchNudgeMock = vi.fn()
  const shouldApplyNudgeMock = vi.fn()
  const armExitWatchdogMock = vi.fn()
  const disarmExitWatchdogMock = vi.fn()
  const fetchNewerReleaseTagsMock = vi.fn()
  const fetchLatestStableReleaseTagMock = vi.fn<() => Promise<string | null>>()
  const chooseLocalBuildMock = vi.fn()
  const startLocalBuildFeedMock = vi.fn()
  const closeLocalBuildFeedMock = vi.fn()

  const moduleFactories: UpdaterModuleFactories = {
    electron: () => ({
      app: appMock,
      BrowserWindow: browserWindowMock,
      autoUpdater: nativeUpdaterMock,
      powerMonitor: { on: powerMonitorOnMock },
      shell: { showItemInFolder: vi.fn() },
      net: { fetch: vi.fn() }
    }),
    electronUpdater: () => ({ autoUpdater: autoUpdaterMock }),
    electronUpdaterLoader: () => ({ loadElectronAutoUpdater: loadGenerationScopedAutoUpdater }),
    ptyKillAll: () => ({ killAllPty: killAllPtyMock }),
    // Keep real artifact capture/redaction under test; fake only package-type detection.
    linuxUpdatePackageType: () => ({
      getLinuxPackageType: getLinuxPackageTypeMock,
      getLinuxRootPackageType: getLinuxRootPackageTypeMock,
      isExternallyManagedLinuxInstall: isExternallyManagedLinuxInstallMock
    }),
    updaterLifecycleDiagnostics: () => ({ recordUpdaterLifecycle: recordUpdaterLifecycleMock }),
    updaterChangelog: () => ({ fetchChangelog: fetchChangelogMock }),
    updaterNudge: () => ({ fetchNudge: fetchNudgeMock, shouldApplyNudge: shouldApplyNudgeMock }),
    updateInstallExitWatchdog: () => ({
      armUpdateInstallExitWatchdog: armExitWatchdogMock,
      disarmUpdateInstallExitWatchdog: disarmExitWatchdogMock
    }),
    updaterPrereleaseFeed: () => ({
      fetchLatestStableReleaseTag: fetchLatestStableReleaseTagMock,
      fetchNewerReleaseTagsWithReadiness: async (...args: unknown[]) => {
        const result = await fetchNewerReleaseTagsMock(...args)
        return Array.isArray(result)
          ? { tags: result, state: result.length > 0 ? 'ready' : 'no-newer' }
          : result
      },
      getReleaseDownloadUrl: (tag: string) =>
        `https://github.com/stablyai/orca/releases/download/${tag}`
    }),
    localBuildSwitch: () => ({ chooseLocalBuild: chooseLocalBuildMock }),
    localBuildFeedServer: () => ({ startLocalBuildFeed: startLocalBuildFeedMock })
  }

  const resetUpdaterMocks = () => {
    vi.clearAllTimers()
    vi.useRealTimers()
    // The generation fence ignores stale calls but does not cancel their timers.
    clearTrackedRealTimers()
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.quit.mockReset()
    appMock.isPackaged = true
    killAllPtyMock.mockReset()
    armExitWatchdogMock.mockReset()
    disarmExitWatchdogMock.mockReset()
    powerMonitorOnMock.mockReset()
    getLinuxRootPackageTypeMock.mockReset().mockReturnValue(null)
    getLinuxPackageTypeMock.mockReset().mockImplementation(() => {
      return getLinuxRootPackageTypeMock() ?? 'non-root'
    })
    isExternallyManagedLinuxInstallMock.mockReset().mockReturnValue(false)
    recordUpdaterLifecycleMock.mockReset()
    fetchNudgeMock.mockReset().mockResolvedValue(null)
    shouldApplyNudgeMock.mockReset().mockReturnValue(false)
    fetchChangelogMock.mockReset().mockResolvedValue(null)
    fetchNewerReleaseTagsMock.mockReset().mockResolvedValue([])
    fetchLatestStableReleaseTagMock.mockReset().mockResolvedValue('v1.0.51')
    chooseLocalBuildMock.mockReset()
    closeLocalBuildFeedMock.mockReset()
    startLocalBuildFeedMock.mockReset().mockResolvedValue({
      url: 'http://127.0.0.1:1234/token/',
      close: closeLocalBuildFeedMock
    })
    vi.unstubAllGlobals()
    trackRealTimers()
  }

  // Drop fake timers before restoring real globals, or the wrapper's identity guard cannot restore them.
  afterAll(() => {
    vi.useRealTimers()
    clearTrackedRealTimers()
  })

  return {
    appMock,
    browserWindowMock,
    nativeUpdaterMock,
    autoUpdaterMock,
    killAllPtyMock,
    powerMonitorOnMock,
    getLinuxPackageTypeMock,
    getLinuxRootPackageTypeMock,
    isExternallyManagedLinuxInstallMock,
    recordUpdaterLifecycleMock,
    fetchChangelogMock,
    fetchNudgeMock,
    shouldApplyNudgeMock,
    armExitWatchdogMock,
    disarmExitWatchdogMock,
    fetchNewerReleaseTagsMock,
    fetchLatestStableReleaseTagMock,
    chooseLocalBuildMock,
    startLocalBuildFeedMock,
    closeLocalBuildFeedMock,
    moduleFactories,
    resetUpdaterMocks
  }
}
