import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronApp = vi.hoisted(() => ({
  isPackaged: false,
  on: vi.fn(),
  getPath: vi.fn(() => '/tmp/orca-user-data'),
  getVersion: vi.fn(() => '0.0.0-test'),
  isReady: vi.fn(() => true),
  focus: vi.fn()
}))
const launchHooks = vi.hoisted(() => ({
  duringInstallDirRepair: (): void => {},
  failBeforeWindow: false
}))

vi.mock('electron', () => ({ app: electronApp, powerMonitor: { on: vi.fn() } }))
vi.mock('../orca-profiles/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => ({ configured: false })
}))
vi.mock('../orca-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => '/tmp/orca-user-data',
  migrateMobilePairingDataToCanonicalUserDataPath: vi.fn()
}))
const launchOrder = vi.hoisted((): string[] => [])
const rpcOptions = vi.hoisted((): Record<string, unknown>[] => [])
vi.mock('../runtime/rpc/server/runtime-rpc', () => ({
  OrcaRuntimeRpcServer: class {
    constructor(options: Record<string, unknown>) {
      rpcOptions.push(options)
    }
    start = vi.fn(async () => {
      launchOrder.push('rpc-start')
    })
    setOnUnpairedDeviceAuthFailure = vi.fn()
    setMobileDesktopRelayHosts = vi.fn()
  }
}))
vi.mock('../runtime/session-graph/headless-runtime-graph', () => ({
  publishHeadlessRuntimeGraph: vi.fn()
}))
vi.mock('./headless-serve-ssh-registration', () => ({
  registerHeadlessServeSshHandlers: vi.fn(() => {
    launchOrder.push('ssh-registered')
  })
}))
vi.mock('../ipc/mobile', () => ({ registerMobileHandlers: vi.fn() }))
vi.mock('../ipc/runtime-environments/runtime-environment-mobile-relay-hosts', () => ({
  createRuntimeEnvironmentMobileRelayHosts: vi.fn()
}))
vi.mock('../ipc/pty/provider/registry', () => ({ getLocalPtyProvider: vi.fn() }))
vi.mock('../ipc/pty/register-headless-runtime', () => ({ registerHeadlessPtyRuntime: vi.fn() }))
vi.mock('../providers/local-pty/local-pty-provider', () => ({ LocalPtyProvider: class {} }))
vi.mock('../browser/backends/offscreen-browser-backend', () => ({
  OffscreenBrowserBackend: class {}
}))
vi.mock('../browser/browser-manager', () => ({ browserManager: {} }))
vi.mock('./main-process-relay-status', () => ({
  getDesktopRelayStatus: vi.fn(),
  publishDesktopRelayStatus: vi.fn()
}))
vi.mock('./main-process-relay-startup', () => ({ startDesktopRelayService: vi.fn() }))
vi.mock('./main-process-serve', () => ({
  getServeOptions: vi.fn(() => null),
  getBundledWebClientRoot: vi.fn(() => null),
  printServeReady: vi.fn()
}))
vi.mock('./main-process-pty-startup', () => ({
  bindTerminalRuntimeStartupServices: vi.fn(),
  handleCodexHomePtySpawned: vi.fn(),
  handlePtyExit: vi.fn(),
  startTerminalRuntimeStartupServices: vi.fn(() => ({}))
}))
vi.mock('./codex-launch-preparation', () => ({ prepareCodexRuntimeHomeForLaunch: vi.fn() }))
vi.mock('./codex-session-resume-launch', () => ({ prepareCodexSessionResumeForLaunch: vi.fn() }))
vi.mock('./windows-install-dir-acl-recovery', () => ({
  // Model the awaited repair gap in which a second-instance activation can arrive.
  repairKnownPoisonedInstallDirBeforeWindow: vi.fn(async () => {
    launchHooks.duringInstallDirRepair()
    if (launchHooks.failBeforeWindow) {
      throw new Error('install-dir repair failed')
    }
    return 'not-marked'
  })
}))
vi.mock('./serve-signal-handlers', () => ({ registerServeSignalHandlers: vi.fn() }))
vi.mock('./serve-native-quit-guard', () => ({ installServeNativeQuitGuard: vi.fn() }))
vi.mock('../runtime/rpc/server/runtime-rpc-startup-failure', () => ({
  recordRuntimeRpcStartFailure: vi.fn(),
  showRuntimeRpcStartupFailureDialog: vi.fn()
}))
vi.mock('../cli/cli-installer', () => ({ CliInstaller: class {} }))
vi.mock('../cli/linux-bare-orca-dispatcher', () => ({ installLinuxBareOrcaDispatcher: vi.fn() }))
vi.mock('../pty/history/terminal-history-deletion', () => ({
  scheduleAllPendingHistoryTreeRemovals: vi.fn()
}))
vi.mock('../ipc/startup-notification-registration', () => ({
  triggerStartupNotificationRegistration: vi.fn()
}))
vi.mock('./main-process-push-startup', () => ({ startDesktopPushService: vi.fn() }))
vi.mock('./main-process-connector-startup', () => ({
  installDesktopConnectorCloud: vi.fn(),
  connectDesktopConnectorCloud: vi.fn()
}))
vi.mock('./startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))
const setupHeadlessServeAutoUpdater = vi.hoisted(() => vi.fn())
vi.mock('../window/main-window-updater', () => ({ setupHeadlessServeAutoUpdater }))
vi.mock('../server/serve-stdout-boundary', () => ({ emitServeBrowserIdentityActionLine: vi.fn() }))
vi.mock('../browser/identity/browser-identity-mode-store', () => ({
  getBrowserIdentityModeStatus: vi.fn()
}))
const showWindowWithoutStealingFocus = vi.hoisted(() => vi.fn())
const isOrcadSidecarLaunch = vi.hoisted(() => vi.fn(() => false))
vi.mock('../window/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => true,
  isOrcadSidecarLaunch,
  isWindowlessLaunch: () => false,
  showWindowWithoutStealingFocus
}))
vi.mock('../tray/system-tray', () => ({
  createSystemTray: vi.fn(),
  setMacMenuBarIconVisible: vi.fn()
}))
vi.mock('../window/attach-main-window-services', () => ({ ensureAutoUpdaterConfigured: vi.fn() }))
vi.mock('../window/dashboard-popout-window', () => ({ getDashboardPopoutWindow: () => null }))
vi.mock('../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))
vi.mock('../window/renderer-recovery-prompt', () => ({ presentRendererRecoveryPrompt: vi.fn() }))

vi.mock('./main-process-ready-foundation', () => ({
  initializeReadyFoundation: vi.fn(async () => {})
}))
vi.mock('./main-process-ready-runtime', () => ({
  initializeReadyRuntimeServices: vi.fn(async () => {})
}))
vi.mock('./main-process-i18n-menu', () => ({
  initializeMainProcessI18nAndMenu: vi.fn(async () => {})
}))

const { initializeMainProcessReady } = await import('./main-process-ready')
const { mainProcessState: state } = await import('./main-process-state')
const { createServeDesktopActivationGate } = await import('./serve-desktop-activation')
const { focusExistingMainWindow } = await import('../window/focus-existing-window')

type FakeWindow = {
  id: number
  webContents: {
    id: number
    isLoading: () => boolean
    once: (event: string, listener: () => void) => void
  }
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: () => void
  once: () => void
}

const originalPlatform = process.platform

describe('desktop startup activation', () => {
  let windows: FakeWindow[]
  let ipcHandles: Set<string>
  let trustedRendererId: number | null
  let firstLoadListeners: (() => void)[]
  const startupSettled = vi.fn()

  // Retain non-idempotent window effects that exposed duplicate startup in production.
  function openMainWindow(): FakeWindow {
    const id = windows.length + 1
    const window: FakeWindow = {
      id,
      webContents: {
        id,
        isLoading: () => true,
        once: (event, listener) => {
          if (event === 'did-finish-load') {
            firstLoadListeners.push(listener)
          }
        }
      },
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      once: vi.fn()
    }
    windows.push(window)
    trustedRendererId = id
    if (ipcHandles.has('window:isMaximized')) {
      throw new Error("Attempted to register a second handler for 'window:isMaximized'")
    }
    ipcHandles.add('window:isMaximized')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch only reads the fields FakeWindow provides.
    state.mainWindow = window as unknown as NonNullable<typeof state.mainWindow>
    return window
  }

  beforeEach(() => {
    windows = []
    showWindowWithoutStealingFocus.mockClear()
    isOrcadSidecarLaunch.mockReturnValue(false)
    ipcHandles = new Set()
    trustedRendererId = null
    firstLoadListeners = []
    startupSettled.mockClear()
    launchHooks.duringInstallDirRepair = () => {}
    launchHooks.failBeforeWindow = false
    state.mainWindow = null
    state.isServeMode = false
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch only null-checks the runtime and marks its launch-record warm-up, and gives it the sender peer-key reader, before the mocked RPC server takes it.
    state.runtime = {
      noteAgentLaunchStartupSettled: startupSettled,
      setAgentSenderPeerKey: () => {}
    } as unknown as NonNullable<typeof state.runtime>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch only calls whenReady().
    state.windowsShellPathHydration = {
      whenReady: () => Promise.resolve()
    } as unknown as NonNullable<typeof state.windowsShellPathHydration>
    state.initialProxyApplicationReady = Promise.resolve()
    state.desktopActivationGate = createServeDesktopActivationGate({
      initialState: 'initializing',
      activateWindow: () =>
        focusExistingMainWindow({
          app: electronApp,
          getWindow: () => state.mainWindow,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: focusExistingMainWindow only calls the FakeWindow methods.
          openWindow: () => openMainWindow() as unknown as NonNullable<typeof state.mainWindow>
        })
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    electronApp.isPackaged = false
  })

  it.each([
    ['darwin', false],
    ['linux', false],
    ['win32', true]
  ] as const)(
    'focuses the startup window when a second instance lands before it exists (%s)',
    async (platform, isPackaged) => {
      Object.defineProperty(process, 'platform', { value: platform })
      electronApp.isPackaged = isPackaged
      launchHooks.duringInstallDirRepair = () => state.desktopActivationGate?.requestActivation()

      await initializeMainProcessReady({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch only calls once() on the returned window.
        openMainWindow: () => openMainWindow() as unknown as NonNullable<typeof state.mainWindow>,
        handleMacAppActivation: vi.fn()
      })

      expect(windows).toHaveLength(1)
      expect(trustedRendererId).toBe(windows[0].id)
      expect(state.mainWindow).toBe(windows[0])
      expect(showWindowWithoutStealingFocus).toHaveBeenCalledWith(windows[0])
      expect(state.desktopActivationGate?.getState()).toBe('ready')
    }
  )

  it('does not replay an activation when launch fails before the startup window', async () => {
    launchHooks.duringInstallDirRepair = () => state.desktopActivationGate?.requestActivation()
    launchHooks.failBeforeWindow = true

    await expect(
      initializeMainProcessReady({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch only calls once() on the returned window.
        openMainWindow: () => openMainWindow() as unknown as NonNullable<typeof state.mainWindow>,
        handleMacAppActivation: vi.fn()
      })
    ).rejects.toThrow('install-dir repair failed')

    expect(windows).toHaveLength(0)
    expect(state.desktopActivationGate).toBeNull()
  })
})
