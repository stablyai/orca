import { vi } from 'vitest'
import type { Mock } from 'vitest'

/** Loose spy signature for the electron/electron-updater calls the suites only assert on. */
type UpdaterSpy = Mock<(...args: unknown[]) => unknown>

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
  electronToolkitUtils: () => { is: { dev: boolean } }
  ipcPty: () => { killAllPty: UpdaterSpy }
  linuxUpdatePackageType: () => { getLinuxRootPackageType: Mock<() => 'deb' | 'rpm' | null> }
  updaterLifecycleDiagnostics: () => { recordUpdaterLifecycle: UpdaterSpy }
  updaterChangelog: () => { fetchChangelog: UpdaterSpy }
  updaterNudge: () => { fetchNudge: UpdaterSpy; shouldApplyNudge: UpdaterSpy }
  updateInstallExitWatchdog: () => {
    armUpdateInstallExitWatchdog: UpdaterSpy
    disarmUpdateInstallExitWatchdog: UpdaterSpy
  }
  updaterPrereleaseFeed: () => {
    fetchNewerReleaseTagsWithReadiness: (...args: unknown[]) => Promise<unknown>
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
  isMock: { dev: boolean }
  killAllPtyMock: UpdaterSpy
  powerMonitorOnMock: UpdaterSpy
  getLinuxRootPackageTypeMock: Mock<() => 'deb' | 'rpm' | null>
  recordUpdaterLifecycleMock: UpdaterSpy
  fetchChangelogMock: UpdaterSpy
  fetchNudgeMock: UpdaterSpy
  shouldApplyNudgeMock: UpdaterSpy
  armExitWatchdogMock: UpdaterSpy
  disarmExitWatchdogMock: UpdaterSpy
  fetchNewerReleaseTagsMock: UpdaterSpy
  chooseLocalBuildMock: UpdaterSpy
  startLocalBuildFeedMock: UpdaterSpy
  closeLocalBuildFeedMock: UpdaterSpy
  moduleFactories: UpdaterModuleFactories
  resetUpdaterMocks: () => void
}

// Why: macOS keeps the restart advice because quitting does re-stage a Squirrel update.
export const PRE_COMMIT_INSTALL_FAILURE =
  process.platform === 'darwin'
    ? 'Could not restart to install the update. Quit and reopen Orca, then try again.'
    : 'Could not start the update installer. Orca remains open.'

/**
 * Builds the electron/electron-updater mock graph `updater.ts` runs against, plus the module
 * factories each test file feeds to its own hoisted `vi.mock` calls. Call it from an awaited
 * `vi.hoisted` block so the mocks exist before the mock factories run.
 */
export function createUpdaterMocks(): UpdaterMocks {
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
    // Why: setup installs the diagnostic logger adapter here; tests drive child stderr through it.
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
    emit: appEmit,
    quit: vi.fn()
  }
  const browserWindowMock = {
    getAllWindows: vi.fn(() => [])
  }
  const nativeUpdaterMock = {
    on: vi.fn()
  }
  const isMock = { dev: false }
  const killAllPtyMock = vi.fn()
  const powerMonitorOnMock = vi.fn()
  const getLinuxRootPackageTypeMock = vi.fn<() => 'deb' | 'rpm' | null>(() => null)
  const recordUpdaterLifecycleMock = vi.fn()
  const fetchChangelogMock = vi.fn()
  const fetchNudgeMock = vi.fn()
  const shouldApplyNudgeMock = vi.fn()
  const armExitWatchdogMock = vi.fn()
  const disarmExitWatchdogMock = vi.fn()
  const fetchNewerReleaseTagsMock = vi.fn()
  const chooseLocalBuildMock = vi.fn()
  const startLocalBuildFeedMock = vi.fn()
  const closeLocalBuildFeedMock = vi.fn()

  /** One factory per module `updater.ts` pulls in; test files pass these to their own `vi.mock`. */
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
    electronUpdaterLoader: () => ({ loadElectronAutoUpdater: () => autoUpdaterMock }),
    electronToolkitUtils: () => ({ is: isMock }),
    ipcPty: () => ({ killAllPty: killAllPtyMock }),
    // Why: only the marker resolver is faked so the real artifact capture/redaction path stays under test.
    linuxUpdatePackageType: () => ({ getLinuxRootPackageType: getLinuxRootPackageTypeMock }),
    updaterLifecycleDiagnostics: () => ({ recordUpdaterLifecycle: recordUpdaterLifecycleMock }),
    updaterChangelog: () => ({ fetchChangelog: fetchChangelogMock }),
    updaterNudge: () => ({ fetchNudge: fetchNudgeMock, shouldApplyNudge: shouldApplyNudgeMock }),
    updateInstallExitWatchdog: () => ({
      armUpdateInstallExitWatchdog: armExitWatchdogMock,
      disarmUpdateInstallExitWatchdog: disarmExitWatchdogMock
    }),
    updaterPrereleaseFeed: () => ({
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

  /** Shared `beforeEach` body: fresh module registry plus every mock back to its default. */
  const resetUpdaterMocks = () => {
    // Why first: the outgoing instance owns real timers this registry reset cannot reach — a 45s
    // stall guard among them. Left armed, it fires into whatever clock the next test installs and
    // schedules an update check the next test never asked for.
    appMock.emit('will-quit')
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.quit.mockReset()
    appMock.isPackaged = true
    isMock.dev = false
    killAllPtyMock.mockReset()
    armExitWatchdogMock.mockReset()
    disarmExitWatchdogMock.mockReset()
    powerMonitorOnMock.mockReset()
    getLinuxRootPackageTypeMock.mockReset().mockReturnValue(null)
    recordUpdaterLifecycleMock.mockReset()
    fetchNudgeMock.mockReset().mockResolvedValue(null)
    shouldApplyNudgeMock.mockReset().mockReturnValue(false)
    fetchChangelogMock.mockReset().mockResolvedValue(null)
    fetchNewerReleaseTagsMock.mockReset().mockResolvedValue([])
    chooseLocalBuildMock.mockReset()
    closeLocalBuildFeedMock.mockReset()
    startLocalBuildFeedMock.mockReset().mockResolvedValue({
      url: 'http://127.0.0.1:1234/token/',
      close: closeLocalBuildFeedMock
    })
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }

  return {
    appMock,
    browserWindowMock,
    nativeUpdaterMock,
    autoUpdaterMock,
    isMock,
    killAllPtyMock,
    powerMonitorOnMock,
    getLinuxRootPackageTypeMock,
    recordUpdaterLifecycleMock,
    fetchChangelogMock,
    fetchNudgeMock,
    shouldApplyNudgeMock,
    armExitWatchdogMock,
    disarmExitWatchdogMock,
    fetchNewerReleaseTagsMock,
    chooseLocalBuildMock,
    startLocalBuildFeedMock,
    closeLocalBuildFeedMock,
    moduleFactories,
    resetUpdaterMocks
  }
}
