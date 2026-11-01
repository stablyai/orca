import { app, session } from 'electron'
import { applyBackgroundActivationPolicy } from '../window/foreground-activation-policy'
import { applyElectronProxySettings } from '../network/proxy-settings'
import { installElectronProxyRequestGuard } from '../network/electron-proxy-request-guard'
import { handleElectronProxyLogin } from '../network/electron-proxy-credentials'
import { setNodeDistMirrorSettingReader } from '../node-runtime/node-dist-mirror-setting'
import { handleBrowserGuestLogin } from '../browser/browser-http-auth-prompt'
import { installMainThreadHangWatchdog } from '../hang-watchdog/main-thread-hang-watchdog'
import { preservePreviousHangDetection } from '../hang-watchdog/previous-hang-detection'
import { browserCertificateTrustController, browserManager } from '../browser/browser-manager'
import { browserSiteDisplayController } from '../browser/browser-site-display-controller'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getCanonicalUserDataPath } from '../persistence'
import { getAppEnvironment } from '../../shared/app-environment'
import { loadWslMoveFence } from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { startWslMoveStartup } from '../persistence/moving-wsl-projects/wsl-move-startup'
import { startWslHostsPolicyLiveUpdates } from '../wsl/wsl-hosts-policy-live-update'
import { runPendingWslDriveUncConversions } from '../wsl/wsl-drive-unc-conversion-startup'
import { createProfileStateStoreForStartup } from '../persistence/profile-state/profile-state-startup-authority'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { initializeBrowserClientHostId } from '../browser/browser-client-host-id'
import { scheduleSecretProtectionGapReport } from '../host/deferred-secret-protection-report'
import { withholdUnreachableKeychainForServe } from '../host/serve-keychain-guard'
import { initSshHostKeyStoreFile } from '../ssh/ssh-host-key-store'
import { initOrcadHeldFenceTokenFile } from '../ssh/orcad-held-fence-tokens'
import { neutralizeLegacyTerminalShimDir } from '../pty/legacy-terminal-shim-dir'
import { createWindowsShellPathHydration } from './windows-shell-path-hydration'
import {
  configureWindowsHostGitEnvironmentReadiness,
  setDefaultWslDistroOverride
} from '../git/runner'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import { applyAppIcon } from '../app-icon'
import {
  shouldSuppressDevEducation,
  suppressDevEducationForStore
} from './dev-education-suppression'
import {
  awaitBrowserSessionProxies,
  setBrowserNetworkProxySettingsResolver
} from '../browser/browser-session-proxy'
import { installDocPreviewProtocolHandler } from '../browser/doc-preview-protocol'
import { installMediaPreviewProtocolHandler } from '../media/media-preview-protocol'
import { installJiraImageProtocolHandler } from '../jira/attachments/image-protocol'
import { registerDocPreviewGrantHandlers } from '../ipc/doc-preview-grant-ipc'
import { initializeBrowserSessionsForApp } from '../browser/browser-session-startup'
import {
  initializeBrowserExtensionSupport,
  switchBrowserExtensionSupport
} from '../browser/extensions/browser-extension-startup'
import { whenBrowserExtensionSessionsLoaded } from '../browser/extensions/browser-extension-session-loader'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { logStartupMilestone } from './startup-diagnostics'
import { writeHttp1CompatibilityMarker } from './http1-compatibility-marker'
import { mainProcessState as state } from './main-process-state'
import { syncMacMenuBarIcon } from './main-window-actions'
import { updateGpuAccelerationAboutPanel } from './gpu-lifecycle'
import {
  logWslCliReconciliationResults,
  reconcileManagedWslCliRegistrations
} from '../cli/wsl-cli-registration-reconciliation'
import { createWslCliReconciliationStartupBarrier } from './wsl-cli-reconciliation-startup-barrier'
import { agentHookServer } from '../agent-hooks/server'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { reportProfileStateWriteFailure } from './profile-state-write-failure'
import { reportProfileStateSaveDelay } from './profile-state-save-delay'
import { preloadSsh2 } from '../ssh/ssh2-module-load'

export async function initializeReadyFoundation(): Promise<void> {
  logStartupMilestone('app-ready')
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
  installMainThreadHangWatchdog({ userDataPath: canonicalUserDataPath })
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
  updateGpuAccelerationAboutPanel()
  if (state.isServeMode) {
    // Profile loading can decrypt and hang; fence unreachable keychains first.
    await withholdUnreachableKeychainForServe({
      usesMockKeychain: app.commandLine.hasSwitch('use-mock-keychain')
    })
  }
  // Managed WSL launchers live outside the bundle; reconcile launcher/bridge compatibility after app updates.
  state.managedWslCliReconciliationStatus = 'pending'
  state.managedWslCliReconciliationReady = reconcileManagedWslCliRegistrations({
    isPackaged: app.isPackaged,
    userDataPath: canonicalUserDataPath,
    appVersion: app.getVersion()
  })
    .then((results) => {
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
  state.managedWslCliStartupBarrierReady = createWslCliReconciliationStartupBarrier(
    state.managedWslCliReconciliationReady
  )
  const profile = ensureActiveOrcaProfile()
  state.activeOrcaProfile = profile
  // Read durable browser hosting ID before window argv stamps it or renderer and lease ownership diverge.
  initializeBrowserClientHostId(profile.profileDirectory)
  // Before the profile store and the fence: a conversion that rewrites the profile here leaves
  // nothing to fence.
  runPendingWslDriveUncConversions({
    userDataPath: getAppEnvironment().getPath('userData'),
    profileUserDataPath: getProfileUserDataPath(),
    profileId: profile.profile.id
  })
  // Why before the store loads: its pane normalization tells a moved project's retained rows from
  // a rival host's, and no handler or runtime may give a moving project a new terminal.
  loadWslMoveFence(getAppEnvironment().getPath('userData'))
  const profileState = await createProfileStateStoreForStartup({
    userDataPath: getProfileUserDataPath(),
    dataFile: profile.dataFile,
    databaseFile: profile.stateDatabaseFile,
    profileId: profile.profile.id,
    runtime: 'desktop',
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
  // SSH users keep ssh2 loaded before interactive use, as before #35731; others load it on first connect.
  if (store.getSshTargets().length > 0) {
    preloadSsh2()
  }
  setNodeDistMirrorSettingReader(() => store.getSettings().nodeDistMirrorUrl)
  // Main-process-ready waits on interrupted moves being reset or finished, bounded.
  state.wslMoveStartupRewriteReady = startWslMoveStartup(
    getAppEnvironment().getPath('userData'),
    store
  )
  // Publish proxy readiness before guarding default-session requests; network awaits it, while window creation can proceed.
  state.initialProxyApplicationReady = applyElectronProxySettings(store.getSettings()).then(
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
  if (!state.isServeMode) {
    void state.initialProxyApplicationReady.then(startWslHostsPolicyLiveUpdates)
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
  const windowsShellPathHydration = createWindowsShellPathHydration()
  state.windowsShellPathHydration = windowsShellPathHydration
  configureWindowsHostGitEnvironmentReadiness(
    process.platform === 'win32' ? windowsShellPathHydration.whenReady : null
  )
  if (process.platform === 'win32') {
    const settings = store.getSettings()
    if (app.isPackaged) {
      void windowsShellPathHydration.hydrate(
        settings.terminalWindowsShell,
        settings.terminalWindowsPowerShellImplementation
      )
    } else {
      windowsShellPathHydration.configure(
        settings.terminalWindowsShell,
        settings.terminalWindowsPowerShellImplementation
      )
    }
  }
  wslHookRelayManager.setManagedHookSettingsResolver(() => state.store?.getSettings() ?? null)
  logStartupMilestone('store-loaded')
  // Refresh the tiny pre-ready marker so next launch avoids reparsing settings.
  writeHttp1CompatibilityMarker(
    canonicalUserDataPath,
    store.getSettings().electronHttp1CompatibilityMode === true,
    profile.profile.id
  )
  setDefaultWslDistroOverride(store.getSettings().terminalWindowsWslDistro ?? null)
  store.onSettingsChanged((updates, settings) => {
    if ('electronHttp1CompatibilityMode' in updates) {
      writeHttp1CompatibilityMarker(
        canonicalUserDataPath,
        settings.electronHttp1CompatibilityMode === true,
        profile.profile.id
      )
    }
    if ('terminalWindowsWslDistro' in updates) {
      setDefaultWslDistroOverride(settings.terminalWindowsWslDistro ?? null)
    }
    if (
      ('terminalWindowsShell' in updates || 'terminalWindowsPowerShellImplementation' in updates) &&
      process.platform === 'win32'
    ) {
      if (app.isPackaged) {
        void windowsShellPathHydration.hydrate(
          settings.terminalWindowsShell,
          settings.terminalWindowsPowerShellImplementation
        )
      } else {
        windowsShellPathHydration.configure(
          settings.terminalWindowsShell,
          settings.terminalWindowsPowerShellImplementation
        )
      }
    }
    if ('experimentalBrowserExtensions' in updates) {
      void switchBrowserExtensionSupport(settings.experimentalBrowserExtensions === true)
    }
    if ('showMenuBarIcon' in updates) {
      // Store owns settings mutations; sync every menu-bar toggle through this listener.
      syncMacMenuBarIcon(settings.showMenuBarIcon !== false)
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
  applyAppIcon(store.getSettings().appIcon)
  if (shouldSuppressDevEducation({ isDev: !app.isPackaged })) {
    suppressDevEducationForStore(store)
  }
  // Install the proxy resolver before partitions materialize.
  setBrowserNetworkProxySettingsResolver(() => state.store!.getSettings())
  // Protocol-scoped preview handlers must exist before webview attachment.
  installMediaPreviewProtocolHandler()
  installJiraImageProtocolHandler()
  installDocPreviewProtocolHandler()
  registerDocPreviewGrantHandlers()
  // Session setup needs the extension support decision before loading profiles.
  initializeBrowserExtensionSupport({
    enabled: store.getSettings().experimentalBrowserExtensions === true,
    savedBrowserTabs: store
  })
  // Desktop webviews and runtime commands share sessions; initialize without waiting for renderer IPC.
  initializeBrowserSessionsForApp({
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
  browserSiteDisplayController.followZoomSettings(store)
  browserManager.setSiteDisplayController(browserSiteDisplayController)
  try {
    // Await proxy writes so first guest navigation cannot race them.
    await awaitBrowserSessionProxies(browserSessionRegistry.listProfiles())
  } catch {
    console.warn('[proxy] Failed to apply network proxy settings to browser sessions')
  }
  // Why bounded: restored tabs should get content scripts, but a slow extension never blocks launch.
  await whenBrowserExtensionSessionsLoaded(3_000)
}
