import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../orca-profiles/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => ({ configured: false })
}))
vi.mock('../orca-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/tmp/orca-user-data',
  migrateMobilePairingDataToCanonicalUserDataPath: vi.fn()
}))
vi.mock('../runtime/runtime-rpc', () => ({
  OrcaRuntimeRpcServer: class {
    start = vi.fn(async () => {})
    setOnUnpairedDeviceAuthFailure = vi.fn()
  }
}))
vi.mock('../ipc/mobile', () => ({ registerMobileHandlers: vi.fn() }))
vi.mock('../ipc/pty', () => ({
  getLocalPtyProvider: vi.fn(),
  registerHeadlessPtyRuntime: vi.fn()
}))
vi.mock('../providers/local-pty-provider', () => ({ LocalPtyProvider: class {} }))
vi.mock('../browser/offscreen-browser-backend', () => ({ OffscreenBrowserBackend: class {} }))
vi.mock('../browser/browser-manager', () => ({ browserManager: {} }))
vi.mock('./main-process-relay-status', () => ({
  getDesktopRelayStatus: vi.fn(),
  publishDesktopRelayStatus: vi.fn()
}))
vi.mock('../runtime/relay/desktop-relay-service', () => ({ DesktopRelayService: class {} }))
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
  // The awaited gap before the first window, where a second-instance launch can land.
  repairKnownPoisonedInstallDirBeforeWindow: vi.fn(async () => {
    launchHooks.duringInstallDirRepair()
    if (launchHooks.failBeforeWindow) {
      throw new Error('install-dir repair failed')
    }
    return 'not-marked'
  })
}))
vi.mock('./serve-signal-handlers', () => ({ registerServeSignalHandlers: vi.fn() }))
vi.mock('../runtime/runtime-rpc-startup-failure', () => ({
  recordRuntimeRpcStartFailure: vi.fn(),
  showRuntimeRpcStartupFailureDialog: vi.fn()
}))
vi.mock('../cli/cli-installer', () => ({ CliInstaller: class {} }))
vi.mock('../cli/linux-bare-orca-dispatcher', () => ({ installLinuxBareOrcaDispatcher: vi.fn() }))
vi.mock('../terminal-history-deletion', () => ({ scheduleAllPendingHistoryTreeRemovals: vi.fn() }))
vi.mock('../ipc/startup-notification-registration', () => ({
  triggerStartupNotificationRegistration: vi.fn()
}))
vi.mock('./main-process-push-startup', () => ({ startDesktopPushService: vi.fn() }))
vi.mock('./startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))
vi.mock('../server/serve-stdout-boundary', () => ({ emitServeBrowserIdentityActionLine: vi.fn() }))
vi.mock('../browser/browser-identity-mode-store', () => ({
  getBrowserIdentityModeStatus: vi.fn()
}))
const showWindowWithoutStealingFocus = vi.hoisted(() => vi.fn())
vi.mock('../window/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => true,
  isWindowlessLaunch: () => false,
  showWindowWithoutStealingFocus
}))

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
  webContents: { id: number }
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

  // Mirrors openMainWindow's non-idempotent side effects that broke in the field.
  function openMainWindow(): FakeWindow {
    const id = windows.length + 1
    const window: FakeWindow = {
      id,
      webContents: { id },
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
    ipcHandles = new Set()
    trustedRendererId = null
    launchHooks.duringInstallDirRepair = () => {}
    launchHooks.failBeforeWindow = false
    state.mainWindow = null
    state.isServeMode = false
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch only null-checks the runtime before the mocked RPC server takes it.
    state.runtime = {} as NonNullable<typeof state.runtime>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch only calls whenReady().
    state.windowsShellPathHydration = {
      whenReady: () => Promise.resolve()
    } as unknown as NonNullable<typeof state.windowsShellPathHydration>
    state.initialProxyApplicationReady = Promise.resolve()
    // Built the way preflight builds it for a desktop launch.
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

  it('still opens a window for an activation when launch fails before the startup window', async () => {
    launchHooks.duringInstallDirRepair = () => state.desktopActivationGate?.requestActivation()
    launchHooks.failBeforeWindow = true

    await expect(
      initializeMainProcessReady({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch only calls once() on the returned window.
        openMainWindow: () => openMainWindow() as unknown as NonNullable<typeof state.mainWindow>,
        handleMacAppActivation: vi.fn()
      })
    ).rejects.toThrow('install-dir repair failed')

    expect(windows).toHaveLength(1)
    expect(state.desktopActivationGate?.getState()).toBe('ready')
  })

  it('holds every launch mode behind the gate until startup settles it', () => {
    const preflightSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
      'utf8'
    )
    expect(preflightSource).toContain("initialState: 'initializing',")
    expect(preflightSource).not.toContain(
      "initialState: state.isServeMode ? 'initializing' : 'ready'"
    )
  })
})
