import { app, session } from 'electron'
import { configureMacMenuDeadKeyGuard } from '../menu/macos-menu-dead-key'
import { applyBackgroundActivationPolicy } from '../window/activation/foreground-activation-policy'
import { applyElectronProxySettings } from '../network/proxy-settings'
import { installElectronProxyRequestGuard } from '../network/electron-proxy-request-guard'
import { handleElectronProxyLogin } from '../network/electron-proxy-credentials'
import { setNodeDistMirrorSettingReader } from '../node-runtime/node-dist-mirror-setting'
import { handleBrowserGuestLogin } from '../browser/guest-lifecycle/prompts/browser-http-auth-prompt'
import { installMainThreadHangWatchdog } from '../hang-watchdog/main-thread-hang-watchdog'
import { preservePreviousHangDetection } from '../hang-watchdog/previous-hang-detection'
import {
  browserCertificateTrustController,
  browserManager
} from '../browser/guest-lifecycle/manager/browser-manager'
import { browserSiteDisplayController } from '../browser/site-settings/display/browser-site-display-controller'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { initializeTeamCapabilities } from '../orca-profiles/cloud-auth/initialize-team-capabilities'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { loadWslMappedDriveAnswers } from '../wsl/filesystem/wsl-mapped-drive-answers-file'
import { loadWslMoveFence } from '../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { startWslMoveStartup } from '../persistence/moving-wsl-projects/startup/wsl-move-startup'
import { wslHostsGateOpen } from '../wsl/host-lifecycle/wsl-host-gate'
import { createProfileStateStoreForStartup } from '../persistence/profile-state/startup/profile-state-startup-authority'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { initializeBrowserClientHostId } from '../browser/client-hosts/lifecycle/browser-client-host-id'
import { scheduleSecretProtectionGapReport } from '../host/deferred-secret-protection-report'
import { initSshHostKeyStoreFile } from '../ssh/host-keys/ssh-host-key-store'
import { initOrcadHeldFenceTokenFile } from '../managed-server/activation/orcad-held-fence-tokens'
import { neutralizeLegacyTerminalShimDir } from '../pty/shell-startup/legacy-terminal-shim-dir'
import { configureWindowsHostGitEnvironmentReadiness } from '../git/command-runner/host-routing/windows-host-git-environment'
import { setDefaultWslDistroOverride } from '../git/command-runner/host-routing/wsl-command-resolution'
import { wslHookRelayManager } from '../agent-hooks/wsl-relay/wsl-hook-relay-manager'
import { applyAppIcon } from '../window/desktop-integration/app-icon'
import { setBrowserNetworkProxySettingsResolver } from '../browser/sessions/proxy/browser-session-proxy'
import { installPreviewProtocolHandlers } from './preview-protocol-handlers'
import { registerLazyDocPreviewGrantHandlers } from '../ipc/register-lazy-doc-preview-grant-handlers'
import {
  initializeBrowserSessionsForApp,
  whenBrowserSessionsReadyForRestoredTabs
} from '../browser/sessions/browser-session-startup'
import { initializeBrowserExtensionSupport } from '../browser/extensions/browser-extension-startup'
import { logStartupMilestone } from './diagnostics/startup-diagnostics'
import { writeHttp1CompatibilityMarker } from './network-compatibility/http1-compatibility-marker'
import { mainProcessState as state } from './main-process-state'
import { createStoreNativeSettingsProjection } from '../core-desktop/native-settings-projection'
import { followNativeSettingChanges } from './native-setting-subscriptions'
import { updateGpuAccelerationAboutPanel } from './gpu-recovery/gpu-lifecycle'
import { agentHookServer } from '../agent-hooks/server/agent-hook-server'
import { isAgentStatusHooksEnabled } from '../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import { reportProfileStateWriteFailure } from './profile-startup/profile-state-write-failure'
import { reportProfileStateSaveDelay } from './profile-startup/profile-state-save-delay'

export async function initializeReadyFoundation(): Promise<void> {
  logStartupMilestone('app-ready')
  configureMacMenuDeadKeyGuard()
  // Background automation and a windowless serve must not claim the macOS Dock/menu bar.
  applyBackgroundActivationPolicy({
    serveWithoutDesktopWindow: state.isServeMode,
    warn: console.warn
  })
  installElectronProxyRequestGuard(session.defaultSession)
  app.on('login', (event, webContents, details, authInfo, callback) => {
    handleElectronProxyLogin(
      event,
      webContents,
      details,
      authInfo,
      callback,
      session.defaultSession
    )
    handleBrowserGuestLogin(event, webContents, details, authInfo, callback)
  })
  const canonicalUserDataPath = getCanonicalUserDataPath()
  preservePreviousHangDetection(canonicalUserDataPath)
  const hangWatchdog = installMainThreadHangWatchdog({ userDataPath: canonicalUserDataPath })
  // Install certificate decisions before any webview/headless window can issue TLS.
  app.on(
    'certificate-error',
    (event, webContents, url, error, certificate, callback, isMainFrame) => {
      browserCertificateTrustController.handleCertificateError({
        event,
        webContents,
        url,
        error,
        certificate,
        callback,
        isMainFrame
      })
    }
  )
  const identity = state.devInstanceIdentity
  if (!identity) {
    throw new Error('Development identity is unavailable')
  }
  if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? identity.appUserModelId : process.execPath)
  }
  // Post-ready naming preserves packaged Keychain identity; dev already renamed before ready.
  app.setName(identity.appName)
  // Older builds put an unread count on the dock icon; clear any that is still showing.
  if (process.platform === 'darwin') {
    app.dock?.setBadge('')
  }
  updateGpuAccelerationAboutPanel()
  if (state.isServeMode) {
    // Profile loading can decrypt and hang; fence unreachable keychains first.
    const { withholdUnreachableKeychainForServe } = await import('../host/serve-keychain-guard')
    await withholdUnreachableKeychainForServe({
      usesMockKeychain: app.commandLine.hasSwitch('use-mock-keychain')
    })
  }
  // Managed WSL launchers live outside the bundle; reconcile launcher/bridge compatibility after app updates.
  if (process.platform === 'win32' && app.isPackaged) {
    state.managedWslCliReconciliationStatus = 'pending'
    state.managedWslCliReconciliationReady =
      import('../cli/wsl/wsl-cli-registration-reconciliation')
        .then(async ({ logWslCliReconciliationResults, reconcileManagedWslCliRegistrations }) => {
          const results = await reconcileManagedWslCliRegistrations({
            isPackaged: app.isPackaged,
            userDataPath: canonicalUserDataPath,
            appVersion: app.getVersion()
          })
          logWslCliReconciliationResults(results)
          state.managedWslCliReconciliationStatus = 'settled'
        })
        .catch((error) => {
          state.managedWslCliReconciliationStatus = 'failed'
          console.warn(
            '[wsl-cli] Managed registration reconciliation discovery failed:',
            error instanceof Error ? error.message : String(error)
          )
        })
    const { createWslCliReconciliationStartupBarrier } =
      await import('./wsl-startup/wsl-cli-reconciliation-startup-barrier')
    state.managedWslCliStartupBarrierReady = createWslCliReconciliationStartupBarrier(
      state.managedWslCliReconciliationReady
    )
  } else {
    state.managedWslCliReconciliationStatus = 'settled'
    state.managedWslCliReconciliationReady = Promise.resolve()
    state.managedWslCliStartupBarrierReady = Promise.resolve()
  }
  const profile = ensureActiveOrcaProfile()
  state.activeOrcaProfile = profile
  await initializeTeamCapabilities(getProfileUserDataPath(), profile.profile)
  // Read durable browser hosting ID before window argv stamps it or renderer and lease ownership diverge.
  initializeBrowserClientHostId(profile.profileDirectory)
  // Before the profile store and the fence: a conversion that rewrites the profile here leaves
  // nothing to fence.
  if (wslHostsGateOpen()) {
    const { runPendingWslDriveUncConversions } =
      await import('../wsl/filesystem/wsl-drive-unc-conversion-startup')
    await runPendingWslDriveUncConversions({
      userDataPath: getAppEnvironment().getPath('userData'),
      profileUserDataPath: getProfileUserDataPath(),
      profileId: profile.profile.id
    })
  }
  // Why before the store loads: its pane normalization tells a moved project's retained rows from
  // a rival host's, and no handler or runtime may give a moving project a new terminal.
  // Saved drive answers first: the fence and the move prune read them and never a drive.
  await loadWslMappedDriveAnswers(getAppEnvironment().getPath('userData'))
  loadWslMoveFence(getAppEnvironment().getPath('userData'))
  const profileState = await createProfileStateStoreForStartup({
    userDataPath: getProfileUserDataPath(),
    dataFile: profile.dataFile,
    databaseFile: profile.stateDatabaseFile,
    profileId: profile.profile.id,
    runtime: 'desktop',
    initializeHomeWorkspace: !state.isServeMode,
    storageAuthority: state.isServeMode ? 'runtime' : 'desktop',
    onPersistenceFailure: reportProfileStateWriteFailure,
    onPersistenceSaveDelayChanged: reportProfileStateSaveDelay
  })
  state.profileStateStartup = {
    backend: profileState.backend,
    classification: profileState.classification,
    runtime: 'desktop',
    migrated: profileState.migrated
  }
  const store = profileState.store
  state.store = store
  const nativeSettings = createStoreNativeSettingsProjection(store)
  state.nativeSettings = nativeSettings
  hangWatchdog?.setMenuBarIconSetting(nativeSettings.getSettings().showMenuBarIcon !== false)
  // SSH users keep ssh2 loaded before interactive use, as before #35731; others load it on first connect.
  if (store.getSshTargets().length > 0) {
    void import('../ssh/authentication/ssh2-module-load').then(({ preloadSsh2 }) => preloadSsh2())
  }
  setNodeDistMirrorSettingReader(() => store.getSettings().nodeDistMirrorUrl)
  // Main-process-ready waits on interrupted moves being reset or finished, bounded.
  state.wslMoveStartupRewriteReady = startWslMoveStartup(
    getAppEnvironment().getPath('userData'),
    store
  )
  // Publish proxy readiness before guarding default-session requests; network awaits it, while window creation can proceed.
  state.initialProxyApplicationReady = applyElectronProxySettings(
    nativeSettings.getSettings()
  ).then(
    (result) => {
      if (result.source === 'invalid-settings') {
        // STA-3442: log invalid configured proxies so DIRECT fallback is diagnosable.
        console.warn('[proxy] persisted proxy settings are invalid; using direct networking')
      }
    },
    () => {
      console.warn('[proxy] Failed to apply network proxy settings')
    }
  )
  installElectronProxyRequestGuard(session.defaultSession)
  if (!state.isServeMode && process.platform === 'win32') {
    void state.initialProxyApplicationReady.then(async () => {
      const { startWslHostsPolicyLiveUpdates } =
        await import('../wsl/host-lifecycle/wsl-hosts-policy-live-update')
      startWslHostsPolicyLiveUpdates()
    })
  }
  // Wait for profile-sidecar location, then defer potentially blocking OS-keyring probes past first paint (STA-5765).
  scheduleSecretProtectionGapReport({
    dataFile: profile.dataFile,
    force: process.env.ORCA_ALWAYS_REPORT_SECRET_PROTECTION === '1',
    deferUntilFirstWindow: !state.isServeMode,
    skipInDevelopment: !app.isPackaged
  })
  // Bind the profile host-key sidecar before connects or accepted trust records silently vanish each launch.
  initSshHostKeyStoreFile(profile.dataFile)
  initOrcadHeldFenceTokenFile(profile.dataFile)
  // Neutralize legacy shims before PTY handlers, including headless serve which never opens a main window.
  neutralizeLegacyTerminalShimDir(app.getPath('userData'))
  const applyWindowsShellPath = (settings: ReturnType<typeof store.getSettings>): void => {
    const hydration = state.windowsShellPathHydration
    if (!hydration) {
      return
    }
    const { terminalWindowsShell: shell, terminalWindowsPowerShellImplementation: ps } = settings
    if (app.isPackaged) {
      void hydration.hydrate(shell, ps)
    } else {
      hydration.configure(shell, ps)
    }
  }
  if (process.platform === 'win32') {
    const { createWindowsShellPathHydration } =
      await import('./shell-environment/windows-shell-path-hydration')
    const windowsShellPathHydration = createWindowsShellPathHydration()
    state.windowsShellPathHydration = windowsShellPathHydration
    configureWindowsHostGitEnvironmentReadiness(windowsShellPathHydration.whenReady)
    applyWindowsShellPath(store.getSettings())
  } else {
    state.windowsShellPathHydration = null
    configureWindowsHostGitEnvironmentReadiness(null)
  }
  wslHookRelayManager.setManagedHookSettingsResolver(() => state.store?.getSettings() ?? null)
  logStartupMilestone('store-loaded')
  // Refresh the tiny pre-ready marker so next launch avoids reparsing settings.
  writeHttp1CompatibilityMarker(
    canonicalUserDataPath,
    nativeSettings.getSettings().electronHttp1CompatibilityMode === true,
    profile.profile.id
  )
  setDefaultWslDistroOverride(store.getSettings().terminalWindowsWslDistro ?? null)
  followNativeSettingChanges(nativeSettings, {
    canonicalUserDataPath,
    profileId: profile.profile.id,
    hangWatchdog
  })
  store.onSettingsChanged((updates, settings) => {
    if ('terminalWindowsWslDistro' in updates) {
      setDefaultWslDistroOverride(settings.terminalWindowsWslDistro ?? null)
    }
    if (
      ('terminalWindowsShell' in updates || 'terminalWindowsPowerShellImplementation' in updates) &&
      process.platform === 'win32'
    ) {
      applyWindowsShellPath(settings)
    }
    if ('agentStatusHooksEnabled' in updates) {
      agentHookServer.setStatusHooksEnabled(isAgentStatusHooksEnabled(settings))
      // The ensure gate blocks only new relays; stop live guests/timers on disable and resume on enable for existing panes.
      if (isAgentStatusHooksEnabled(settings)) {
        wslHookRelayManager.resumeStoppedRelays()
      } else {
        wslHookRelayManager.disposeAll({ permanent: false })
      }
    }
  })
  applyAppIcon(nativeSettings.getSettings().appIcon)
  if (!app.isPackaged) {
    const { shouldSuppressDevEducation, suppressDevEducationForStore } =
      await import('./profile-startup/dev-education-suppression')
    if (shouldSuppressDevEducation({ isDev: true })) {
      suppressDevEducationForStore(store)
    }
  }
  // Install the proxy resolver before partitions materialize.
  setBrowserNetworkProxySettingsResolver(() => nativeSettings.getSettings())
  installPreviewProtocolHandlers()
  registerLazyDocPreviewGrantHandlers()
  // Session setup needs the extension support decision before loading profiles.
  initializeBrowserExtensionSupport({
    enabled: nativeSettings.getSettings().browserExtensionsEnabled !== false,
    savedBrowserTabs: store
  })
  // Desktop webviews and runtime commands share sessions; initialize without waiting for renderer IPC.
  await initializeBrowserSessionsForApp({
    orcaProfileId: profile.profile.id,
    profileDirectory: profile.profileDirectory,
    // Sweep against current SSH targets or live target cookie jars look orphaned.
    listLocalSshTargetIds: () => {
      const currentStore = state.store
      if (!currentStore) {
        // An empty list would delete every SSH jar; throw to skip sweeping when the store is unavailable.
        throw new Error('ssh target store unavailable at partition sweep')
      }
      return currentStore.getSshTargets().map((target) => target.id)
    }
  })
  browserSiteDisplayController.followZoomSettings(nativeSettings)
  browserManager.setSiteDisplayController(browserSiteDisplayController)
  await whenBrowserSessionsReadyForRestoredTabs()
}
