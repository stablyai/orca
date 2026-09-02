import { app, session } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import { applyBackgroundActivationPolicy } from '../window/foreground-activation-policy'
import { applyElectronProxySettings } from '../network/proxy-settings'
import { installElectronProxyRequestGuard } from '../network/electron-proxy-request-guard'
import { handleElectronProxyLogin } from '../network/electron-proxy-credentials'
import { installMainThreadHangWatchdog } from '../hang-watchdog/main-thread-hang-watchdog'
import {
  consumeHangDetectionMarker,
  hangDetectionMarkerPath
} from '../hang-watchdog/hang-detection-marker'
import { browserCertificateTrustController } from '../browser/browser-manager'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { Store, getCanonicalUserDataPath } from '../persistence'
import { initializeBrowserClientHostId } from '../browser/browser-client-host-id'
import { scheduleSecretProtectionGapReport } from '../host/deferred-secret-protection-report'
import { initSshHostKeyStoreFile } from '../ssh/ssh-host-key-store'
import { neutralizeLegacyTerminalShimDir } from '../pty/legacy-terminal-shim-dir'
import { createWindowsShellPathHydration } from './windows-shell-path-hydration'
import {
  configureWindowsHostGitEnvironmentReadiness,
  setDefaultWslDistroOverride
} from '../git/runner'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import {
  attachClaudeLivePtyPersistence,
  onLiveClaudePtysDrained,
  seedLiveClaudePtysFromPersistence
} from '../claude-accounts/live-pty-gate'
import { applyAppIcon } from '../app-icon'
import {
  shouldSuppressDevEducation,
  suppressDevEducationForStore
} from './dev-education-suppression'
import {
  applyBrowserSessionProxies,
  setBrowserNetworkProxySettingsResolver
} from '../browser/browser-session-proxy'
import { installDocPreviewProtocolHandler } from '../browser/doc-preview-protocol'
import { registerDocPreviewGrantHandlers } from '../ipc/doc-preview-grant-ipc'
import { initializeBrowserSessionsForApp } from '../browser/browser-session-startup'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { logStartupMilestone } from './startup-diagnostics'
import { mainProcessState as state } from './main-process-state'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { syncMacMenuBarIcon } from './main-window-actions'
import { updateGpuAccelerationAboutPanel } from './gpu-lifecycle'
import { reconcileManagedWslCliRegistrations } from '../cli/wsl-cli-registration-reconciliation'
import { createWslCliReconciliationStartupBarrier } from './wsl-cli-reconciliation-startup-barrier'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'

export async function initializeReadyFoundation(): Promise<void> {
  logStartupMilestone('app-ready')
  // Why: a headless automated run must not claim a macOS Dock tile or the menu bar.
  applyBackgroundActivationPolicy({ warn: console.warn })
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
  })
  const canonicalUserDataPath = getCanonicalUserDataPath()
  installMainThreadHangWatchdog({ userDataPath: canonicalUserDataPath })
  state.hangDetection = consumeHangDetectionMarker(hangDetectionMarkerPath(canonicalUserDataPath))
  if (state.hangDetection) {
    recordDurableCrashBreadcrumb('main_thread_hang_detected', {
      unresponsiveMs: state.hangDetection.unresponsiveMs,
      previousPid: state.hangDetection.parentPid,
      selfRecovered: state.hangDetection.selfRecovered
    })
  }
  // Why: install certificate decisions before any webview or headless window issues its first TLS request.
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
  electronApp.setAppUserModelId(identity.appUserModelId)
  // Why: names the app menu/About panel. Dev already applied this pre-ready (see the
  // safeStorage note above); this call stays unconditional so packaged builds keep their
  // existing post-ready rename, which lands after the Keychain name is already resolved.
  app.setName(identity.appName)
  updateGpuAccelerationAboutPanel()
  // Why: managed WSL launchers live outside the Windows app bundle, so keep their launcher/bridge contract synced across app updates.
  state.managedWslCliReconciliationStatus = 'pending'
  state.managedWslCliReconciliationReady = reconcileManagedWslCliRegistrations({
    isPackaged: app.isPackaged,
    userDataPath: canonicalUserDataPath,
    appVersion: app.getVersion()
  })
    .then((results) => {
      for (const result of results) {
        if (result.outcome === 'failed') {
          console.warn(
            `[wsl-cli] ${result.distro} managed registration reconciliation failed: ${result.error}`
          )
        } else if (result.outcome === 'repaired') {
          console.log(`[wsl-cli] Repaired managed registration in ${result.distro}.`)
        }
      }
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
  // Why this early: the first window stamps the hosting id into its renderer's argv, so the durable
  // read has to have happened by then or the renderer and the browser-host lease disagree.
  initializeBrowserClientHostId(profile.profileDirectory)
  const store = new Store({
    dataFile: profile.dataFile,
    storageAuthority: state.isServeMode ? 'runtime' : 'desktop'
  })
  state.store = store
  // Why: create pending readiness before the guard can observe the default session.
  const initialProxyApplication = applyElectronProxySettings(store.getSettings())
  installElectronProxyRequestGuard(session.defaultSession)
  // Why armed here and not at install time: the report remembers what it last said, and
  // that state lives beside the profile data file, which does not exist until now.
  // Why scheduled and not called: the report probes the OS keyring, which blocks on Linux
  // and must not gate the first window (STA-5765).
  scheduleSecretProtectionGapReport({
    dataFile: profile.dataFile,
    force: process.env.ORCA_ALWAYS_REPORT_SECRET_PROTECTION === '1',
    deferUntilFirstWindow: !state.isServeMode,
    skipInDevelopment: is.dev
  })
  // Why here: the host key store is a sidecar of the same profile, and every SSH connect consults
  // it. Left unbound it reports nothing trusted, which is safe but silently discards our own
  // accept records on every launch.
  initSshHostKeyStoreFile(profile.dataFile)
  // Why: must precede PTY handler registration and run in headless serve too, which returns before openMainWindow.
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
  // Why: apply initial fallback WSL distro from store settings for global git/CLI calls.
  setDefaultWslDistroOverride(store.getSettings().terminalWindowsWslDistro ?? null)
  store.onSettingsChanged((updates, settings) => {
    if ('terminalWindowsWslDistro' in updates) {
      // Why: synchronize fallback WSL distro updates to runner.
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
    if ('showMenuBarIcon' in updates) {
      // Why: Store is the mutation authority for all settings writes, so every macOS toggle updates the native item live.
      syncMacMenuBarIcon(settings.showMenuBarIcon !== false)
    }
    if ('agentStatusHooksEnabled' in updates) {
      // Why both directions: the ensure gate only blocks NEW relays, so off must stop the running
      // guest process and timers, and on must restart them — otherwise open WSL panes report no
      // status until their next spawn.
      if (isAgentStatusHooksEnabled(settings)) {
        wslHookRelayManager.resumeStoppedRelays()
      } else {
        wslHookRelayManager.disposeAll({ permanent: false })
      }
    }
  })
  // Why: run before ClaudeRuntimeAuthService's constructor sync — a surviving daemon Claude CLI holds the single-use refresh token; early refresh rotates it out mid-session.
  attachClaudeLivePtyPersistence(store)
  // Why: while a live claude defers the managed OAuth refresh, usage shows
  // "Waiting for Claude session"; refetch when the last live PTY exits so the
  // error clears immediately instead of after the failure backoff.
  onLiveClaudePtysDrained(() => {
    void state.rateLimits?.refreshAfterClaudeLivePtysDrained()
  })
  const persistedClaudePtyIds = store.getClaudeLivePtySessionIds()
  seedLiveClaudePtysFromPersistence(persistedClaudePtyIds)
  if (persistedClaudePtyIds.length > 0) {
    console.log(
      `[claude-live-pty] Seeded ${persistedClaudePtyIds.length} persisted Claude session id(s) into the refresh gate`
    )
  }
  applyAppIcon(store.getSettings().appIcon)
  if (shouldSuppressDevEducation({ isDev: is.dev })) {
    suppressDevEducationForStore(store)
  }
  try {
    // Why: Dock/Launchpad launches don't inherit shell proxy env vars, so apply the persisted proxy before any app-owned network fetchers run.
    const proxyApplyResult = await initialProxyApplication
    if (proxyApplyResult.source === 'invalid-settings') {
      // Why (STA-3442): a silent DIRECT fallback made a dead configured proxy undiagnosable.
      console.warn('[proxy] persisted proxy settings are invalid; using direct networking')
    }
  } catch {
    console.warn('[proxy] Failed to apply network proxy settings')
  }
  // Why: the partition installer reads the proxy through this resolver, so register it before sessions materialize.
  setBrowserNetworkProxySettingsResolver(() => state.store!.getSettings())
  // Why: the preview session is protocol-scoped, so the handler must exist before any preview webview attaches.
  installDocPreviewProtocolHandler()
  registerDocPreviewGrantHandlers()
  // Why: browser sessions serve desktop webviews and runtime profile commands, so init at app startup rather than via a renderer IPC path.
  initializeBrowserSessionsForApp({
    orcaProfileId: profile.profile.id,
    profileDirectory: profile.profileDirectory,
    // Why: local direct-SSH partitions are scoped to targets, and the orphan
    // sweep must see the live target list or it would clear their cookie jars.
    listLocalSshTargetIds: () => {
      const currentStore = state.store
      if (!currentStore) {
        // Why: an empty list would read as "every SSH jar is an orphan"; throwing skips the sweep.
        throw new Error('ssh target store unavailable at partition sweep')
      }
      return currentStore.getSshTargets().map((target) => target.id)
    }
  })
  try {
    // Why: awaited here so the first guest navigation cannot race the installer's fire-and-forget write.
    await applyBrowserSessionProxies(browserSessionRegistry.listProfiles(), store.getSettings())
  } catch {
    console.warn('[proxy] Failed to apply network proxy settings to browser sessions')
  }
}
