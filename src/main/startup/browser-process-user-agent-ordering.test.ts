import { expect, it, vi } from 'vitest'
import { runMainProcessPreflight } from './main-process-preflight'

const mocks = vi.hoisted(() => {
  const events: string[] = []
  // Use a two-word app token to expose partial removal; retain the engine identity required by the real cleaner.
  let userAgent =
    'Mozilla/5.0 (Test) AppleWebKit/537.36 (KHTML, like Gecko) Orca Development/0.0.0 Chrome/150.0.0.0 Electron/43.0.0 Safari/537.36'
  const app = {
    isPackaged: false,
    exit: vi.fn(),
    // Preflight reads commandLine to select the Linux keyring backend.
    commandLine: { hasSwitch: vi.fn(() => false), appendSwitch: vi.fn() },
    getVersion: vi.fn(() => '1.0.0'),
    getPath: vi.fn(() => '/canonical-user-data'),
    get userAgentFallback(): string {
      events.push('read-user-agent')
      return userAgent
    },
    set userAgentFallback(value: string) {
      events.push('write-user-agent')
      userAgent = value
    },
    isReady: vi.fn(() => {
      events.push('is-ready')
      return false
    }),
    whenReady: vi.fn(() => Promise.resolve()),
    setName: vi.fn((name: string) => {
      events.push(`set-name:${name}`)
    })
  }
  return {
    app,
    events,
    userAgent: () => userAgent,
    showErrorBox: vi.fn(),
    backgroundLaunch: vi.fn(() => true),
    admission: vi.fn(),
    lock: vi.fn(() => true),
    afterIdentity: vi.fn((): void => {
      throw new Error('preflight-test-stop')
    }),
    recoverMoves: vi.fn(),
    profileLock: vi.fn((): { state: string; message?: string } => ({ state: 'unavailable' }))
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  dialog: { showErrorBox: mocks.showErrorBox },
  ipcMain: {},
  powerMonitor: {},
  session: { defaultSession: {} }
}))
vi.mock('../window/foreground-activation-policy', () => ({
  isBackgroundLaunch: mocks.backgroundLaunch
}))
vi.mock('./cli-launch-redirect', () => ({
  maybeRedirectCliLaunch: () => ({ redirected: false, status: 0 })
}))
vi.mock('./serve-mode-argv', () => ({
  argvRequestsServeMode: () => false,
  normalizeServeModeArgv: (argv: string[]) => argv
}))
vi.mock('./configure-process', () => ({
  configureDevUserDataPath: vi.fn(),
  configureElectronNetworkCompatibility: vi.fn(),
  configureOrcaUserDataPathEnv: vi.fn(),
  disableUnsupportedChromiumFeatures: vi.fn(),
  enableMainProcessGpuFeatures: vi.fn(),
  installDevParentDisconnectQuit: vi.fn(),
  installDevParentSignalQuit: vi.fn(),
  installDevParentWatchdog: vi.fn(),
  optOutOfHiddenPageWakeUpThrottling: vi.fn(),
  patchPackagedProcessPath: vi.fn()
}))
vi.mock('../updater/serve-update-handoff', () => ({
  installServeSupervisorDisconnectQuit: vi.fn()
}))
vi.mock('./main-process-error-guards', () => ({
  installUncaughtPipeErrorGuard: vi.fn(),
  installUnhandledRejectionLogging: vi.fn()
}))
vi.mock('./hydrate-shell-path')
vi.mock('../runtime/hosts/management/remote-server-updater', () => ({
  configureRemoteServerUpdater: vi.fn()
}))
vi.mock('../updater/updater-service', () => ({
  getRemoteServerUpdaterSnapshot: vi.fn(),
  checkForRemoteServerUpdate: vi.fn(),
  downloadRemoteServerUpdate: vi.fn(),
  installRemoteServerUpdate: vi.fn(),
  isQuittingForUpdate: () => false
}))
vi.mock('./dev-instance-identity', () => ({
  getDevInstanceIdentity: () => ({
    isDev: true,
    appName: 'Orca Development',
    appUserModelId: 'com.orca.development'
  }),
  shouldApplyPreReadyAppName: () => true
}))
vi.mock('./renderer-heap-headroom')
vi.mock('./startup-diagnostics', () => ({
  isStartupDiagnosticsEnabled: () => false,
  logStartupDiagnostic: vi.fn()
}))
vi.mock('./event-loop-stall-probe')
vi.mock('../diagnostics/main-thread-churn-probe')
vi.mock('../git/source-control/git-read-cache-invalidation', () => ({
  settledDiffCache: { stats: vi.fn() }
}))
vi.mock('../server/serve-stdout-boundary')
vi.mock('./serve-desktop-activation', () => ({
  createServeDesktopActivationGate: () => ({})
}))
vi.mock('./desktop-profile-instance-lock', () => ({
  acquireDesktopProfileInstanceLock: mocks.profileLock
}))
vi.mock('./single-instance-lock', () => ({
  shouldBypassSingleInstanceLock: () => false,
  shouldSkipSingleInstanceLock: () => false,
  acquireSingleInstanceLock: () => {
    mocks.events.push('single-instance-lock')
    return mocks.lock()
  },
  logSingleInstanceLockBypass: vi.fn(),
  logSingleInstanceLockFailure: vi.fn(),
  SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE: 3
}))
vi.mock('../../shared/app-environment', () => ({ setAppEnvironment: vi.fn() }))
vi.mock('../host/electron-app-environment', () => ({ ElectronAppEnvironment: class {} }))
vi.mock('../pty/process-retirement/own-chromium-tree-kill-guard')
vi.mock('../../shared/secret-store', () => ({
  setSecretStore: () => {
    mocks.events.push('continued-after-browser-identity')
    mocks.afterIdentity()
  }
}))
vi.mock('../host/electron-secret-store')
vi.mock('../ipc/pty/pty-host-bindings')
vi.mock('../host/electron-runtime-desktop-surface')
vi.mock('../runtime/construction/runtime-desktop-surface')
vi.mock('../host/electron-browser-commands')
vi.mock('../runtime/browser/installation/runtime-browser-commands-factory')
vi.mock('../host/electron-http-client')
vi.mock('../network/http-client')
vi.mock('../host/electron-speech-services')
vi.mock('../speech/speech-runtime-service')
vi.mock('../workspaces/removal/worktree-watcher-removal')
vi.mock('../ipc/filesystem/watchers/filesystem-watcher', () => ({
  desktopWorktreeWatcherRemoval: {
    closeLocal: vi.fn(),
    restoreLocal: vi.fn(),
    forgetLocal: vi.fn()
  }
}))
vi.mock('../network/proxy-settings')
vi.mock('../persistence/loading-store/user-data-path', () => ({
  initDataPath: () => mocks.events.push('init-data-path'),
  getCanonicalUserDataPath: () => '/canonical-user-data'
}))
vi.mock('../persistence/profile-state/access/profile-state-access', () => ({
  acquireProfileStateRuntimeAdmission: (root: string) => {
    mocks.events.push(`admission:${root}`)
    return mocks.admission()
  }
}))
vi.mock('../window/desktop-integration/macos-press-and-hold-default')
vi.mock('../ai-vault/parse-cache/session-parse-cache-persistence')
vi.mock('../orca-profiles/profile-index-store', () => ({}))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  initOrcaProfilePaths: vi.fn(),
  getProfileUserDataPath: () => '/canonical-user-data'
}))
vi.mock('../orca-profiles/project-transfer/profile-project-move-intent', () => ({
  recoverPendingProfileProjectMoves: mocks.recoverMoves
}))
vi.mock('../persistence/profile-state/offline-access/profile-state-active-location', () => ({
  getActiveProfileStateLocation: () => ({ profileId: 'active-profile' })
}))
vi.mock('../stats/collector')
vi.mock('../claude-usage/store')
vi.mock('../codex-usage/store')
vi.mock('../opencode-usage/store')
vi.mock('../browser/document-preview/doc-preview-protocol')
vi.mock('../crash-reporting/capture/crashpad-capture')
vi.mock('../crash-reporting/reports/crash-report-store')
vi.mock('../crash-reporting/breadcrumbs/crash-breadcrumb-store')
vi.mock('../crash-reporting/breadcrumbs/durable-crash-breadcrumb')
vi.mock('../crash-reporting/capture/gpu-crash-diagnostics')
vi.mock('../crash-reporting/process-exits/main-process-lifecycle-identity')
vi.mock('./ensure-virtual-display', () => ({
  ensureVirtualDisplayForHeadlessServe: vi.fn(),
  hasUsableLinuxDisplay: () => true,
  missingLinuxDisplayMessage: () => 'missing display'
}))
vi.mock('./gpu-lifecycle')
vi.mock('./main-process-state', () => ({ mainProcessState: {} }))
vi.mock('./synthetic-title-runtime')
vi.mock('../browser/identity/mode/browser-identity-mode-store', () => ({
  initializeBrowserIdentityModeStore: (path: string) => {
    mocks.events.push(`read-mode:${path}`)
    return {
      state: 'valid',
      appliedMode: 'clean',
      configuredMode: 'clean',
      explicitSelection: true,
      migrationNoticePending: false
    }
  }
}))

it('exits after a Linux desktop readiness rejection without showing a dialog', async () => {
  const { resetBrowserProcessUserAgentForTests } =
    await import('../browser/identity/browser-process-user-agent')
  resetBrowserProcessUserAgentForTests()
  const release = vi.fn()
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((_resolve, reject) => {
    rejectReady = reject
  })
  mocks.admission.mockReturnValueOnce({ release })
  mocks.afterIdentity.mockImplementationOnce(() => {
    throw new Error('Linux pre-ready failure')
  })
  mocks.app.whenReady.mockReturnValueOnce(ready)
  mocks.app.exit.mockClear()
  mocks.showErrorBox.mockClear()
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  mocks.backgroundLaunch.mockReturnValueOnce(false)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(
      runMainProcessPreflight({ focusExistingWindow: vi.fn(), requestDesktopActivation: vi.fn() })
    ).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    rejectReady(new Error('Electron readiness failed'))
    await ready.catch(() => undefined)
    await Promise.resolve()
    expect(mocks.showErrorBox).not.toHaveBeenCalled()
    expect(mocks.app.exit).toHaveBeenCalledWith(1)
  } finally {
    error.mockRestore()
    platform.mockRestore()
    mocks.app.whenReady.mockClear()
  }
})
