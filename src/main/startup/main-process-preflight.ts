import { antigravityHookService } from '../antigravity/hook-service'
import { getRelocatedDaemonHost } from '../daemon/daemon-host-relocation'
import { app, ipcMain, powerMonitor, session } from 'electron'
import os from 'node:os'
import { join } from 'node:path'
import { maybeRedirectCliLaunch } from './cli-launch-redirect'
import { runProfileStateRecoveryPreflight } from './profile-state-recovery-preflight'
import { argvRequestsServeMode, normalizeServeModeArgv } from './serve-mode-argv'
import {
  configureDevUserDataPath,
  configureElectronNetworkCompatibility,
  configureOrcaUserDataPathEnv,
  disableUnsupportedChromiumFeatures,
  enableMainProcessGpuFeatures,
  installDevParentDisconnectQuit,
  installDevParentSignalQuit,
  installDevParentWatchdog,
  patchPackagedProcessPath,
  optOutOfHiddenPageWakeUpThrottling
} from './configure-process'
import { installServeSupervisorDisconnectQuit } from '../serve-update-handoff'
import {
  installUncaughtPipeErrorGuard,
  installUnhandledRejectionLogging
} from './main-process-error-guards'
import { hydrateShellPath, mergePathSegments } from './hydrate-shell-path'
import { configureRemoteServerUpdater } from '../runtime/remote-server-updater'
import {
  getRemoteServerUpdaterSnapshot,
  checkForRemoteServerUpdate,
  downloadRemoteServerUpdate,
  installRemoteServerUpdate,
  isQuittingForUpdate
} from '../updater'
import { getDevInstanceIdentity, shouldApplyPreReadyAppName } from './dev-instance-identity'
import { enableRendererHeapHeadroom } from './renderer-heap-headroom'
import { configureLinuxDevShmUsage } from './linux-dev-shm-policy'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from './startup-diagnostics'
import { startEventLoopStallProbe } from './event-loop-stall-probe'
import { startEventLoopDelayProbe } from '../diagnostics/event-loop-delay-probe'
import {
  isMainThreadDiagnosticsEnabled,
  recordSubprocessSpawn,
  startMainThreadChurnProbe
} from '../diagnostics/main-thread-churn-probe'
import { setSpawnObserver } from '@orca/process-host/spawn-observer'
import { settledDiffCache } from '../git/source-control/git-read-cache-invalidation'
import { reserveServeStdoutForReadiness } from '../server/serve-stdout-boundary'
import { createServeDesktopActivationGate } from './serve-desktop-activation'
import {
  shouldBypassSingleInstanceLock,
  shouldSkipSingleInstanceLock,
  acquireSingleInstanceLock,
  logSingleInstanceLockBypass,
  logSingleInstanceLockFailure,
  SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
} from './single-instance-lock'
import { setAppEnvironment } from '../../shared/app-environment'
import { ElectronAppEnvironment } from '../host/electron-app-environment'
import { installMainProcessTreeKillGate } from '../own-chromium-tree-kill-guard'
import { setSecretStore } from '../../shared/secret-store'
import { ElectronSecretStore } from '../host/electron-secret-store'
import { selectLinuxKeyringBackend } from './select-linux-keyring-backend'
import { setPtyHostBindings } from '../ipc/pty-host-bindings'
import { electronRuntimeDesktopSurface } from '../host/electron-runtime-desktop-surface'
import { setRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import { installElectronBrowserCommands } from '../host/electron-browser-commands'
import { electronHttpClient } from '../host/electron-http-client'
import { setMainHttpClient } from '../network/http-client'
import { electronSpeechServiceFactories } from '../host/electron-speech-services'
import { setSpeechServiceFactories } from '../speech/speech-runtime-service'
import { setWorktreeWatcherRemoval } from '../ipc/worktree-watcher-removal'
import { desktopWorktreeWatcherRemoval } from '../ipc/filesystem/watchers/filesystem-watcher'
import { setDefaultProxySessionResolver } from '../network/proxy-settings'
import { initDataPath, getCanonicalUserDataPath } from '../persistence'
import { applyMacPressAndHoldDefaultAtStartup } from '../macos-press-and-hold-default'
import { configureSessionParseCachePersistence } from '../ai-vault/session-parse-cache-persistence'
import { initOrcaProfilePaths } from '../orca-profiles/profile-index-store'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { recoverPendingProfileProjectMoves } from '../orca-profiles/profile-project-move-intent'
import { initStatsPath } from '../stats/collector'
import { initClaudeUsagePath } from '../claude-usage/store'
import { initCodexUsagePath } from '../codex-usage/store'
import { initOpenCodeUsagePath } from '../opencode-usage/store'
import { initMuseUsagePath } from '../muse-usage/store'
import { registerDocPreviewSchemePrivileges } from '../browser/doc-preview-protocol'
import { MEDIA_PREVIEW_CUSTOM_SCHEME } from '../media/media-preview-protocol'
import { JIRA_IMAGE_CUSTOM_SCHEME } from '../jira/attachments/image-protocol'
import { startCrashpadCapture } from '../crash-reporting/crashpad-capture'
import { CrashReportStore } from '../crash-reporting/crash-report-store'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { getMainProcessLifecycleIdentity } from '../crash-reporting/main-process-lifecycle-identity'
import {
  ensureVirtualDisplayForHeadlessServe,
  hasUsableLinuxDisplay,
  missingLinuxDisplayMessage
} from './ensure-virtual-display'
import {
  createGpuCrashDiagnosticsRecorder,
  maybeApplyGpuFallbackForThisLaunch,
  registerGpuLifecycleHandlers
} from './gpu-lifecycle'
import { mainProcessState as state } from './main-process-state'
import { initializeSyntheticTitleRuntime } from './synthetic-title-runtime'
import { initializeBrowserProcessUserAgent } from '../browser/browser-process-user-agent'
import { initializeBrowserIdentityModeStore } from '../browser/browser-identity-mode-store'
import { acquireProfileStateRuntimeAdmission } from '../persistence/profile-state/profile-state-access'
import { getActiveProfileStateLocation } from '../persistence/profile-state/profile-state-active-location'
import {
  acquireDesktopProfileLockOrExplain,
  handleMainProcessPreflightFailure
} from './main-process-preflight-failure'
import { ensureWindowsAppDataPath } from './windows-app-data-path'

export type MainProcessPreflightOptions = {
  focusExistingWindow: () => void
  requestDesktopActivation: (argv?: readonly string[]) => void
}

export function runMainProcessPreflight(options: MainProcessPreflightOptions): boolean {
  try {
    return initializeMainProcessPreflight(options)
  } catch (error) {
    console.error('[startup] Preflight failed:', error)
    handleMainProcessPreflightFailure(error)
    return false
  }
}

function initializeMainProcessPreflight(options: MainProcessPreflightOptions): boolean {
  const isDev = !app.isPackaged
  // Resolve Windows appData before recovery/instance-lock steps can read userData.
  ensureWindowsAppDataPath(app)
  if (runProfileStateRecoveryPreflight()) {
    return false
  }
  // Redirect lost node-mode CLI launches before locking or argv rewriting; direct Linux serve exec preserves PID and only falls back on failure.
  const cliLaunchRedirect = maybeRedirectCliLaunch({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath
  })
  if (cliLaunchRedirect.redirected) {
    app.exit(cliLaunchRedirect.status)
  }
  // #12677: extracted binaries can receive CLI-form serve argv without CLI normalization; preserve ordinary GUI argv identity.
  if (argvRequestsServeMode(process.argv)) {
    process.argv = normalizeServeModeArgv(process.argv)
  }
  state.isServeMode = process.argv.includes('--serve')
  // Reject missing display before Chromium teardown can segfault (#13719).
  if (app.isPackaged && !state.isServeMode && !hasUsableLinuxDisplay()) {
    process.stderr.write(`${missingLinuxDisplayMessage(false)}\n`)
    app.exit(1)
  }
  if (state.isServeMode) {
    reserveServeStdoutForReadiness()
  }
  state.devInstanceIdentity = getDevInstanceIdentity(isDev)
  state.devAgentHookEndpointNamespace = state.devInstanceIdentity.isDev
    ? state.devInstanceIdentity.appUserModelId
    : undefined
  state.desktopActivationGate = createServeDesktopActivationGate({
    // Hold activation until the startup window exists; early second-instance activation otherwise opens a duplicate and aborts launch.
    initialState: 'initializing',
    activateWindow: () => {
      // Updater replacement must not resurrect the old bundle.
      if (!isQuittingForUpdate()) {
        options.focusExistingWindow()
      }
    },
    onBlocked: (reason) => console.error(`[serve] Desktop activation blocked: ${reason}`)
  })
  installUncaughtPipeErrorGuard()
  // #9441: log background rejections so restore failure cannot silently kill main.
  installUnhandledRejectionLogging()
  // Expose version without Electron imports for main/daemon TERM_PROGRAM_VERSION.
  process.env.ORCA_APP_VERSION = app.getVersion()
  configureRemoteServerUpdater({
    getSnapshot: getRemoteServerUpdaterSnapshot,
    check: checkForRemoteServerUpdate,
    download: downloadRemoteServerUpdate,
    install: installRemoteServerUpdate
  })
  patchPackagedProcessPath()
  // The synchronous seed covers early IPC; packaged login-shell hydration adds rc PATH later.
  if (app.isPackaged && process.platform !== 'win32') {
    void hydrateShellPath().then((result) => {
      if (result.ok) {
        mergePathSegments(result.segments)
      } else {
        // Failed hydration keeps seeded fallbacks, which may differ from shell choice; log the reason for missing-CLI diagnosis.
        console.warn(
          `[shell-path] login-shell probe failed (${result.failureReason}); using seeded PATH`
        )
      }
    })
  }
  // Register before spawning so CLI/relay-shared tree killing can reach main's gate and breadcrumbs.
  installMainProcessTreeKillGate()
  configureDevUserDataPath(isDev)
  configureOrcaUserDataPathEnv()
  // #16761: install the lazy environment accessor immediately after userData selection or early resolves can throw/memoize the wrong profile.
  setAppEnvironment(new ElectronAppEnvironment())
  // Capture after overrides, before ready-time app naming can change userData on case-sensitive filesystems.
  initDataPath()
  startEventLoopDelayProbe('main', getCanonicalUserDataPath())
  antigravityHookService.setWindowsRuntimePathProvider(
    () => getRelocatedDaemonHost()?.execPath ?? process.execPath
  )

  // Electron fixes the Keychain service name before ready; dev userData is already pinned so renaming cannot shift it.
  if (state.devInstanceIdentity && shouldApplyPreReadyAppName(state.devInstanceIdentity)) {
    app.setName(state.devInstanceIdentity.appName)
  }
  state.startupDiagnosticsEnabled = isStartupDiagnosticsEnabled()
  if (state.startupDiagnosticsEnabled) {
    logStartupDiagnostic('before-single-instance-lock', {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      osRelease: os.release(),
      userData: app.getPath('userData'),
      e2eUserData: Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
    })
    startEventLoopStallProbe()
  }
  // Session-long main-thread diagnostics (#7576) distinguish cold cache from unstable filesystem stamps via hit/miss/unprovable counts.
  if (isMainThreadDiagnosticsEnabled()) {
    // Include process-host spawns too; Git-only probe sites miss rg/ps/PTY helpers.
    setSpawnObserver(recordSubprocessSpawn)
  }
  startMainThreadChurnProbe({ extraStats: () => ({ diffCache: settledDiffCache.stats() }) })
  // Lock after userData override so dev/packaged namespaces differ; concurrent dev copies also need separate profiles to avoid store corruption (#1326, #1312).
  const bypass = shouldBypassSingleInstanceLock({ isDev, isServeMode: state.isServeMode })
  const skip = shouldSkipSingleInstanceLock({ isDev, isServeMode: state.isServeMode })
  if (bypass) {
    // Allow diagnosis of false macOS lock loss before ordinary logs exist.
    logSingleInstanceLockBypass()
  }
  const hasLock = skip || bypass || acquireSingleInstanceLock(app, options.requestDesktopActivation)
  if (state.startupDiagnosticsEnabled) {
    logStartupDiagnostic('single-instance-lock-result', {
      acquired: hasLock,
      bypassed: bypass,
      skippedForE2E: skip
    })
  }
  if (!hasLock) {
    // A false lock loss otherwise resembles a silent crash; stderr remains available to packaged macOS and dev callers.
    logSingleInstanceLockFailure({
      isDevDesktop: isDev && !state.isServeMode,
      userDataPath: app.getPath('userData')
    })
    // Pre-ready graceful quit is deferred; exit now to avoid display-init SIGSEGV (#11935).
    app.exit(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
    return false
  }
  // Electron's lock fences desktops; the shared profile lock also fences orcad serve.
  if (!skip && !bypass && !acquireDesktopProfileLockOrExplain(getCanonicalUserDataPath())) {
    return false
  }
  state.profileStateAdmission = acquireProfileStateRuntimeAdmission(getCanonicalUserDataPath())
  // Renderer and worker defaults must be fixed before any session exists.
  initializeBrowserProcessUserAgent(
    initializeBrowserIdentityModeStore(getCanonicalUserDataPath()).appliedMode
  )
  // Select Linux os_crypt before credential reads/config initialization; install lazy secret access before Store without triggering pre-ready Keychain resolution.
  selectLinuxKeyringBackend()
  setSecretStore(new ElectronSecretStore())
  // Bind PTY IPC/power at process scope: headless serve has no window yet and must not register no-op handlers.
  setPtyHostBindings({ ipc: ipcMain, power: powerMonitor })
  // Node hosts omit desktop surfaces and route notifications to paired clients instead.
  setRuntimeDesktopSurface(electronRuntimeDesktopSurface)
  // Install Chromium browser commands only in Electron; Node hosts advertise no browser capability and reject those RPCs.
  installElectronBrowserCommands()
  // Electron consults default-session proxy config; Node hosts use environment only.
  setDefaultProxySessionResolver(() => session.defaultSession)
  // Desktop integrations use Chromium networking; Node differs in proxy environment and user agent.
  setMainHttpClient(electronHttpClient)
  // Only Electron supplies streaming speech services; other hosts reject speech calls.
  setSpeechServiceFactories(electronSpeechServiceFactories)
  setWorktreeWatcherRemoval(desktopWorktreeWatcherRemoval)
  // Couple only dev desktop lifetime; serve must outlive its CLI shim/background-shell parent.
  const shouldCoupleToDevParent = isDev && !state.isServeMode
  installDevParentDisconnectQuit(shouldCoupleToDevParent)
  installDevParentWatchdog(shouldCoupleToDevParent)
  installDevParentSignalQuit(shouldCoupleToDevParent)
  // #16761: install supervisor disconnect after canonical path setup but before any await, which would allow orphaning before listener installation.
  installServeSupervisorDisconnectQuit(state.isServeMode)
  // Use captured userData for the next-launch press-and-hold record.
  applyMacPressAndHoldDefaultAtStartup(getCanonicalUserDataPath())
  // Late app.getPath may change across restarts; persistence needs canonical userData.
  configureSessionParseCachePersistence({
    filePath: join(getCanonicalUserDataPath(), 'ai-vault', 'session-parse-cache.json'),
    appVersion: app.getVersion()
  })
  initOrcaProfilePaths()
  // Recover cross-profile moves before Store opens either profile so no reader sees half-committed ownership.
  const profileUserDataPath = getProfileUserDataPath()
  recoverPendingProfileProjectMoves(
    profileUserDataPath,
    getActiveProfileStateLocation(profileUserDataPath)?.profileId
  )
  // Capture stats/usage paths before app naming can shift userData.
  initStatsPath()
  initClaudeUsagePath()
  initCodexUsagePath()
  initOpenCodeUsagePath()
  initMuseUsagePath()
  // Register preview privileges before ready freezes the table or webviews lose fetch/secure-origin access.
  registerDocPreviewSchemePrivileges([MEDIA_PREVIEW_CUSTOM_SCHEME, JIRA_IMAGE_CUSTOM_SCHEME])
  // Install Crashpad before first renderer; earlier CHECK failures have exit-code evidence only.
  startCrashpadCapture()
  state.crashReports = CrashReportStore.fromUserData()
  state.gpuCrashDiagnostics = createGpuCrashDiagnosticsRecorder()
  recordCrashBreadcrumb('app_started', {
    packaged: app.isPackaged,
    platform: process.platform,
    ...getMainProcessLifecycleIdentity()
  })
  disableUnsupportedChromiumFeatures()
  // Keep unconditional because GPU-fallback launches skip feature setup.
  optOutOfHiddenPageWakeUpThrottling()
  configureElectronNetworkCompatibility()
  enableRendererHeapHeadroom()
  configureLinuxDevShmUsage()
  maybeApplyGpuFallbackForThisLaunch()
  if (!state.gpuFallbackActiveThisLaunch) {
    enableMainProcessGpuFeatures()
  }
  // Linux offscreen browser capability requires a usable X display.
  state.headlessBrowserDisplayAvailable = ensureVirtualDisplayForHeadlessServe({
    isServeMode: state.isServeMode
  })
  // Fail serve before displayless Ozone initialization can SIGSEGV (#17615).
  if (state.isServeMode && !state.headlessBrowserDisplayAvailable) {
    process.stderr.write(`${missingLinuxDisplayMessage(true)}\n`)
    app.exit(1)
  }
  initializeSyntheticTitleRuntime()
  registerGpuLifecycleHandlers()
  return true
}
