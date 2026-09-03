import { app, ipcMain, powerMonitor, session } from 'electron'
import { is } from '@electron-toolkit/utils'
import os from 'node:os'
import { join } from 'node:path'
import { maybeRedirectCliLaunch } from './cli-launch-redirect'
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
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from './startup-diagnostics'
import { startEventLoopStallProbe } from './event-loop-stall-probe'
import { startMainThreadChurnProbe } from '../diagnostics/main-thread-churn-probe'
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
import { installProcessTreeKillBreadcrumbObserver } from '../crash-reporting/self-initiated-tree-kill-log'
import { setSecretStore } from '../../shared/secret-store'
import { ElectronSecretStore } from '../host/electron-secret-store'
import { setPtyHostBindings } from '../ipc/pty-host-bindings'
import { electronRuntimeDesktopSurface } from '../host/electron-runtime-desktop-surface'
import { setRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import { electronRuntimeBrowserCommandsFactory } from '../host/electron-browser-commands'
import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { electronHttpClient } from '../host/electron-http-client'
import { setMainHttpClient } from '../network/http-client'
import { electronSpeechServiceFactories } from '../host/electron-speech-services'
import { setSpeechServiceFactories } from '../speech/speech-runtime-service'
import { setWorktreeWatcherRemoval } from '../ipc/worktree-watcher-removal'
import { desktopWorktreeWatcherRemoval } from '../ipc/filesystem-watcher'
import { setDefaultProxySessionResolver } from '../network/proxy-settings'
import { initDataPath, getCanonicalUserDataPath } from '../persistence'
import { applyMacPressAndHoldDefaultAtStartup } from '../macos-press-and-hold-default'
import { initSessionParseCachePersistence } from '../ai-vault/session-parse-cache-persistence'
import { initOrcaProfilePaths } from '../orca-profiles/profile-index-store'
import { initStatsPath } from '../stats/collector'
import { initClaudeUsagePath } from '../claude-usage/store'
import { initCodexUsagePath } from '../codex-usage/store'
import { initOpenCodeUsagePath } from '../opencode-usage/store'
import { registerDocPreviewSchemePrivileges } from '../browser/doc-preview-protocol'
import { startCrashpadCapture } from '../crash-reporting/crashpad-capture'
import { CrashReportStore } from '../crash-reporting/crash-report-store'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { GpuCrashDiagnosticsRecorder } from '../crash-reporting/gpu-crash-diagnostics'
import { getMainProcessLifecycleIdentity } from '../crash-reporting/main-process-lifecycle-identity'
import {
  ensureVirtualDisplayForHeadlessServe,
  hasUsableLinuxDisplay,
  MISSING_LINUX_DISPLAY_MESSAGE
} from './ensure-virtual-display'
import { maybeApplyGpuFallbackForThisLaunch, registerGpuLifecycleHandlers } from './gpu-lifecycle'
import { mainProcessState as state } from './main-process-state'
import { initializeSyntheticTitleRuntime } from './synthetic-title-runtime'

export type MainProcessPreflightOptions = {
  focusExistingWindow: () => void
  requestDesktopActivation: (argv?: readonly string[]) => void
}

/** Performs all module-scope work that must happen before Electron's ready event. */
export function runMainProcessPreflight(options: MainProcessPreflightOptions): boolean {
  // Why: on Windows a CLI launch that lost ELECTRON_RUN_AS_NODE would boot the GUI and exit silently; redirect to node mode before the lock gate below.
  // The redirect runs before the serve-argv rewrite so it still matches on the launch argv verbatim.
  // Direct serve stays in-process so its signal handlers own all children.
  const cliLaunchRedirect = maybeRedirectCliLaunch({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath
  })
  if (cliLaunchRedirect.redirected) {
    app.exit(cliLaunchRedirect.status)
  }
  // Why: extracted AppRun / binary launches can land CLI-form `serve` args on the
  // Electron process without the CLI rewrite that injects `--serve` (#12677).
  // Guarded so a normal GUI launch keeps its original argv array identity.
  if (argvRequestsServeMode(process.argv)) {
    process.argv = normalizeServeModeArgv(process.argv)
  }
  state.isServeMode = process.argv.includes('--serve')
  // Fail before Chromium's missing-display teardown can segfault (#13719).
  if (app.isPackaged && !state.isServeMode && !hasUsableLinuxDisplay()) {
    process.stderr.write(`${MISSING_LINUX_DISPLAY_MESSAGE}\n`)
    app.exit(1)
  }
  if (state.isServeMode) {
    reserveServeStdoutForReadiness()
  }
  state.devInstanceIdentity = getDevInstanceIdentity(is.dev)
  state.devAgentHookEndpointNamespace = state.devInstanceIdentity.isDev
    ? state.devInstanceIdentity.appUserModelId
    : undefined
  state.desktopActivationGate = createServeDesktopActivationGate({
    initialState: state.isServeMode ? 'initializing' : 'ready',
    activateWindow: () => {
      // Why: an updater replacement must not resurrect the old app bundle.
      if (!isQuittingForUpdate()) {
        options.focusExistingWindow()
      }
    },
    onBlocked: (reason) => console.error(`[serve] Desktop activation blocked: ${reason}`)
  })
  installUncaughtPipeErrorGuard()
  // Why (issue #9441): without this, one rejected background promise during startup restore kills main silently (exit 1, no crash report).
  installUnhandledRejectionLogging()
  // Why: expose the app version via process.env so main and the forked daemon can set TERM_PROGRAM_VERSION without importing electron.
  process.env.ORCA_APP_VERSION = app.getVersion()
  configureRemoteServerUpdater({
    getSnapshot: getRemoteServerUpdaterSnapshot,
    check: checkForRemoteServerUpdate,
    download: downloadRemoteServerUpdate,
    install: installRemoteServerUpdate
  })
  patchPackagedProcessPath()
  // Why: the sync seed above covers early IPC (homebrew/nix); the async login-shell probe below (packaged only) then adds the user's rc PATH.
  if (app.isPackaged && process.platform !== 'win32') {
    void hydrateShellPath().then((result) => {
      if (result.ok) {
        mergePathSegments(result.segments)
      } else {
        // Why: on failure the seeded fallbacks stay in front. For an nvm user that is
        // now their `default` version rather than the newest install, so it is usually
        // survivable — but it is still not what their shell would have resolved. Name
        // the reason so it shows up in a log bundle instead of as a missing CLI.
        console.warn(
          `[shell-path] login-shell probe failed (${result.failureReason}); using seeded PATH`
        )
      }
    })
  }
  // Why before any spawn: `signalProcessTree` is shared with the CLI and relay, so
  // it can only reach the main-process breadcrumb store through a registered observer.
  installProcessTreeKillBreadcrumbObserver()
  const isDev = is.dev
  configureDevUserDataPath(isDev)
  configureOrcaUserDataPathEnv()
  // Why these four lines are one step (#16761): the two above decide where userData lives, and
  // everything below may resolve a path. Installing the accessor any later leaves a window where an
  // early resolve either throws — which is what killed `orca serve` — or, worse, memoizes the
  // pre-override directory and silently writes user state to the wrong place for the whole session.
  // Safe this early: ElectronAppEnvironment holds no state and calls `app` lazily per accessor, so it
  // changes no timing, and initDataPath only joins strings.
  setAppEnvironment(new ElectronAppEnvironment())
  // Why captured now: after the dev/E2E override above, and before app.setName('Orca') (whenReady)
  // changes how userData resolves on a case-sensitive filesystem. See persistence.ts:20-28.
  initDataPath()
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
  // Self-gated on ORCA_MAIN_THREAD_DIAGNOSTICS; runs the whole session to catch steady-state churn (issue #7576).
  // Why the diff-cache counters ride along: a stamp the filesystem reports unstably makes the cache
  // look exactly like a cold start, and only the hit/miss/unprovable split tells the two apart.
  startMainThreadChurnProbe({ extraStats: () => ({ diffCache: settledDiffCache.stats() }) })
  // Why: acquire AFTER configureDevUserDataPath — Electron derives lock identity from `userData`, so dev/packaged lock in separate namespaces.
  // Why skip in dev: parallel `pnpm dev` from multiple worktrees would make the second exit silently; packaged keeps the lock (corruption PR #1326 / #1312).
  const bypass = shouldBypassSingleInstanceLock({ isDev, isServeMode: state.isServeMode })
  const skip = shouldSkipSingleInstanceLock({ isDev, isServeMode: state.isServeMode })
  if (bypass) {
    // Why: diagnostic escape hatch for macOS builds where Electron reports a false lock loss before any app logs exist.
    logSingleInstanceLockBypass()
  }
  const hasLock = skip || bypass || acquireSingleInstanceLock(app, options.requestDesktopActivation)
  if (state.startupDiagnosticsEnabled) {
    logStartupDiagnostic('single-instance-lock-result', {
      acquired: hasLock,
      bypassed: bypass,
      skippedForDev: skip
    })
  }
  if (!hasLock) {
    // Why: a false-negative lock loss otherwise looks like a silent crash on packaged macOS; `open --stderr` can capture this line.
    logSingleInstanceLockFailure()
    // Why: a graceful quit is deferred pre-ready, so this launch would still walk into Linux display init and SIGSEGV (#11935).
    app.exit(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
    return false
  }
  // Why first in this block: the accessor throws until installed and everything below may read a
  // credential. The constructor does not touch `safeStorage` — it resolves lazily per call — so
  // installing here changes no timing, in particular not the pre-ready Keychain service-name
  // resolution. The app-environment port and the userData capture install earlier still, next to
  // the path decision they depend on.
  setSecretStore(new ElectronSecretStore())
  // Why at process level, not per-window: pty.ts registers against injected surfaces so
  // it can load without electron, and an Electron main process always has ipcMain —
  // whether a window exists is irrelevant. Installing this in attachMainWindowServices
  // meant `orca serve` registered its PTY handlers against no-ops before any window
  // attached, so a paired desktop owner never received them.
  setPtyHostBindings({ ipc: ipcMain, power: powerMonitor })
  // Why also at process level: the runtime's notification, window-lookup and
  // tab-create-reply channel are desktop-only. A Node host installs none and the
  // runtime routes notifications to paired clients instead.
  setRuntimeDesktopSurface(electronRuntimeDesktopSurface)
  // Why here: constructing RuntimeBrowserCommands is what pulls the Chromium browser
  // cluster into the graph. The desktop installs it; a Node host installs none and every
  // browser RPC rejects, which capability filtering already tells clients about.
  setRuntimeBrowserCommandsFactory(electronRuntimeBrowserCommandsFactory)
  // Why here: proxy-settings only needed electron for `session.defaultSession`. The
  // desktop supplies it; a Node host has no Chromium proxy config to consult, so the
  // environment variables are the whole answer there.
  setDefaultProxySessionResolver(() => session.defaultSession)
  // Why here: integrations use Chromium's network stack on the desktop. A Node host
  // falls back to the platform default, which is a real behavioural difference (proxy
  // read from the environment, Node's user agent) rather than a transparent swap.
  setMainHttpClient(electronHttpClient)
  // Why here: constructing the speech services is what pulls Electron's streaming net
  // request in. A host without them rejects speech calls rather than pretending.
  setSpeechServiceFactories(electronSpeechServiceFactories)
  setWorktreeWatcherRemoval(desktopWorktreeWatcherRemoval)
  // Why: couple to dev-parent only for electron-vite desktop runs; `orca serve`'s parent (CLI shim/background shell) isn't the intended server lifetime.
  const shouldCoupleToDevParent = isDev && !state.isServeMode
  installDevParentDisconnectQuit(shouldCoupleToDevParent)
  installDevParentWatchdog(shouldCoupleToDevParent)
  installDevParentSignalQuit(shouldCoupleToDevParent)
  // Why not at module scope with the other lifetime couplings (#16761): this resolves the handoff
  // path, so it throws until setAppEnvironment() above installs the accessor — which killed every
  // `orca serve` process before it could listen. After initDataPath() specifically, so the
  // path-equality check against the CLI's env var uses the dir captured before app.setName().
  // Safe to defer, and must stay synchronous: no 'disconnect' can be delivered until this module
  // finishes evaluating, so moving this behind an await would open a real orphan window.
  installServeSupervisorDisconnectQuit(state.isServeMode)
  // Why here: initDataPath above gives the canonical userData path for the record file; the write
  // itself lands for the next launch (see macos-press-and-hold-default.ts).
  applyMacPressAndHoldDefaultAtStartup(getCanonicalUserDataPath())
  // Why: use the canonical userData path — late app.getPath('userData') can resolve differently across restarts, defeating persistence.
  initSessionParseCachePersistence({
    filePath: join(getCanonicalUserDataPath(), 'ai-vault', 'session-parse-cache.json'),
    appVersion: app.getVersion()
  })
  initOrcaProfilePaths()
  // Why: same timing as initDataPath — capture userData before app.setName changes it. See persistence.ts:20-28.
  initStatsPath()
  initClaudeUsagePath()
  initCodexUsagePath()
  initOpenCodeUsagePath()
  // Why: Electron resolves the macOS safeStorage Keychain service name
  // ("<app name> Safe Storage") before `ready`, so the setName in whenReady is
  // too late to move it — dev otherwise lands on the package.json name. Dev-only
  // so a packaged build keeps deriving the key from its own CFBundleName.
  // Safe here: dev always pins userData via app.setPath (configure-process.ts),
  // so setName cannot shift the paths captured just above.
  if (state.devInstanceIdentity && shouldApplyPreReadyAppName(state.devInstanceIdentity)) {
    app.setName(state.devInstanceIdentity.appName)
  }
  // Why: Electron freezes the privileged scheme table at ready, so the doc-preview
  // scheme must be declared here or its webview loses fetch/secure-origin privileges.
  registerDocPreviewSchemePrivileges()
  // Why: must precede app.whenReady() so Crashpad is installed before the
  // first renderer spawns; a CHECK before this point is still exit-code-only.
  startCrashpadCapture()
  state.crashReports = CrashReportStore.fromUserData()
  state.gpuCrashDiagnostics =
    process.platform === 'win32'
      ? new GpuCrashDiagnosticsRecorder({
          provider: {
            getGPUInfo: (infoType) => app.getGPUInfo(infoType),
            getGPUFeatureStatus: () => app.getGPUFeatureStatus()
          },
          recordBreadcrumb: (data) => recordDurableCrashBreadcrumb('gpu_crash_hardware', data)
        })
      : null
  recordCrashBreadcrumb('app_started', {
    packaged: app.isPackaged,
    platform: process.platform,
    ...getMainProcessLifecycleIdentity()
  })
  disableUnsupportedChromiumFeatures()
  // Why: unconditional — a GPU-fallback launch skips enableMainProcessGpuFeatures() below.
  optOutOfHiddenPageWakeUpThrottling()
  configureElectronNetworkCompatibility()
  enableRendererHeapHeadroom()
  maybeApplyGpuFallbackForThisLaunch()
  if (!state.gpuFallbackActiveThisLaunch) {
    enableMainProcessGpuFeatures()
  }
  // Why: headless serve's offscreen BrowserWindows need an X display (Xvfb) on Linux; the result gates whether the offscreen backend is installed.
  state.headlessBrowserDisplayAvailable = ensureVirtualDisplayForHeadlessServe({
    isServeMode: state.isServeMode
  })
  // Why: continuing without Xvfb lets Ozone initialize without a display and SIGSEGV (#17615).
  if (state.isServeMode && !state.headlessBrowserDisplayAvailable) {
    process.stderr.write(`${MISSING_LINUX_DISPLAY_MESSAGE}\n`)
    app.exit(1)
  }
  initializeSyntheticTitleRuntime()
  registerGpuLifecycleHandlers()
  return true
}
