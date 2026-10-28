import { app, type BrowserWindow } from 'electron'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { placeUnshownLiveTerminalsBestEffort } from '../runtime/terminal/adoption/unshown-live-terminal-placement'
import {
  getCanonicalUserDataPath,
  migrateMobilePairingDataToCanonicalUserDataPath
} from '../persistence'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { registerMobileHandlers } from '../ipc/mobile'
import { createRuntimeEnvironmentMobileRelayHosts } from '../ipc/runtime-environments/runtime-environment-mobile-relay-hosts'
import { getLocalPtyProvider } from '../ipc/pty/provider/registry'
import { registerHeadlessPtyRuntime } from '../ipc/pty/register-headless-runtime'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import { publishHeadlessRuntimeGraph } from '../runtime/headless-runtime-graph'
import { OffscreenBrowserBackend } from '../browser/offscreen-browser-backend'
import { browserManager } from '../browser/browser-manager'
import { getDesktopRelayStatus } from './main-process-relay-status'
import { startDesktopRelayService } from './main-process-relay-startup'
import { getServeOptions, getBundledWebClientRoot, printServeReady } from './main-process-serve'
import {
  bindTerminalRuntimeStartupServices,
  handleCodexHomePtySpawned,
  handlePtyExit,
  startTerminalRuntimeStartupServices
} from './main-process-pty-startup'
import { prepareCodexRuntimeHomeForLaunch } from './codex-launch-preparation'
import { prepareCodexSessionResumeForLaunch } from './codex-session-resume-launch'
import { startWindowsDesktopBeforeShellPathReady } from './windows-desktop-shell-path-startup'
import { repairKnownPoisonedInstallDirBeforeWindow } from './windows-install-dir-acl-recovery'
import { installServeQuitHandling } from './serve-quit-handling'
import { installCloudSessionShutdownFlush } from './cloud-session-shutdown-flush'
import { registerHeadlessServeSshHandlers } from './headless-serve-ssh-registration'
import { settleServeDesktopActivation } from './serve-desktop-activation'
import {
  recordRuntimeRpcStartFailure,
  showRuntimeRpcStartupFailureDialog
} from '../runtime/runtime-rpc-startup-failure'
import { registerCliForHeadlessServe } from './serve-cli-registration'
import { startAppImageCopyPreExtraction } from '../cli/appimage-copy-pre-extraction'
import { scheduleAllPendingHistoryTreeRemovals } from '../terminal-history-deletion'
import { triggerStartupNotificationRegistration } from '../ipc/startup-notification-registration'
import { startDesktopPushService } from './main-process-push-startup'
import {
  connectDesktopConnectorCloud,
  installDesktopConnectorCloud
} from './main-process-connector-startup'
import { mainProcessState as state } from './main-process-state'
import { logStartupMilestone } from './startup-diagnostics'
import { setupHeadlessServeAutoUpdater } from '../window/main-window-updater'
import { preserveStateBeforeUpdateRestart } from '../update-restart-preservation'
import { resolveUpdateInstallMode } from '../updater'
import { scheduleAgentLaunchRecordWarmup } from './agent-launch-record-warmup'
import { emitServeBrowserIdentityActionLine } from '../server/serve-stdout-boundary'
import { getBrowserIdentityModeStatus } from '../browser/browser-identity-mode-store'

type RuntimeService = NonNullable<typeof state.runtime>

export type MainProcessRuntimeLaunchOptions = {
  openMainWindow: (options?: { revealOnDidFinishLoad?: boolean }) => BrowserWindow
  handleMacAppActivation: () => void
}

function settleDesktopActivation(): void {
  const gate = state.desktopActivationGate
  if (!gate) {
    return
  }
  settleServeDesktopActivation(gate, {
    hasPersistentPtyProvider: !(getLocalPtyProvider() instanceof LocalPtyProvider)
  })
}

/** E2E only: a serve host with no browser of its own, as the WSL distro's server is. Never packaged. */
function e2eHeadlessServeWithoutBrowser(): boolean {
  return (
    !app.isPackaged &&
    process.env.ORCA_E2E_HEADLESS === '1' &&
    process.env.ORCA_E2E_HEADLESS_SERVE_WITHOUT_BROWSER === '1'
  )
}

function installRuntimeRpc(
  runtime: RuntimeService,
  serveOptions: ReturnType<typeof getServeOptions> | null
): OrcaRuntimeRpcServer {
  // Migrate pairing credentials from late-resolved userData before switching to the canonical path.
  migrateMobilePairingDataToCanonicalUserDataPath(app.getPath('userData'))
  // Use OS-assigned ports for concurrent E2E Electron instances to avoid EADDRINUSE.
  const isE2E = Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
  const requestedE2EWsPort = process.env.ORCA_E2E_RUNTIME_WS_PORT
  const e2eWsPort = requestedE2EWsPort === undefined ? 0 : Number(requestedE2EWsPort)
  if (isE2E && (!Number.isInteger(e2eWsPort) || e2eWsPort < 0 || e2eWsPort > 65_535)) {
    throw new Error(`Invalid ORCA_E2E_RUNTIME_WS_PORT value: ${requestedE2EWsPort}`)
  }
  // STA-1511: separate dev port from packaged Orca so pairing/repro URLs do not fall back unpredictably.
  const devWsPort = !app.isPackaged && !isE2E ? 6769 : undefined
  const runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    // Pairing must use pre-setName canonical userData or restarts can lose devices.
    userDataPath: getCanonicalUserDataPath(),
    enableWebSocket: true,
    // STA-2370: desktop stays loopback until pairing; serve explicitly opts into remote access and E2E needs harness-wide bind.
    exposeNetworkByDefault: Boolean(serveOptions) || isE2E,
    ...(isE2E ? { wsPort: e2eWsPort } : {}),
    ...(devWsPort !== undefined ? { wsPort: devWsPort } : {}),
    ...(serveOptions?.wsPort !== undefined
      ? {
          wsPort: serveOptions.wsPort,
          // Explicit serve --port replaces stale fallback (#8535); defaults retain fallback-first pairing stability.
          preferPinnedWsPort: true,
          requirePinnedWsPort: true
        }
      : {}),
    webClientRoot: getBundledWebClientRoot()
  })
  state.runtimeRpc = runtimeRpc
  runtimeRpc.setMobileDesktopRelayHosts(createRuntimeEnvironmentMobileRelayHosts())
  registerMobileHandlers(runtimeRpc, {
    getRelayStatus: getDesktopRelayStatus,
    consumePendingUnpairedDeviceAuthFailure: (webContentsId) => {
      if (
        !state.mainWindow ||
        state.mainWindow.isDestroyed() ||
        state.mainWindow.webContents.id !== webContentsId ||
        !state.pendingUnpairedDeviceAuthFailure
      ) {
        return false
      }
      state.pendingUnpairedDeviceAuthFailure = false
      return true
    }
  })
  // Repeated direct-auth failures need a re-pairing explanation rather than silent nonconnection.
  runtimeRpc.setOnUnpairedDeviceAuthFailure(() => {
    // Retain the one-shot across the runtime-start/renderer-mount race.
    state.pendingUnpairedDeviceAuthFailure = true
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('mobile:unpairedDeviceAuthFailure')
    }
  })
  return runtimeRpc
}

async function launchServeMode(
  runtime: RuntimeService,
  runtimeRpc: OrcaRuntimeRpcServer,
  serveOptions: NonNullable<ReturnType<typeof getServeOptions>>
): Promise<void> {
  // Headless serve has no first paint to prioritize; apply persisted proxy before relay/CLI/RPC fetchers.
  await state.initialProxyApplicationReady
  // Give WSL registration brief migration time without letting slow repair hold all RPC readiness.
  logStartupMilestone('wsl-cli-barrier-start')
  await state.managedWslCliStartupBarrierReady
  logStartupMilestone('wsl-cli-barrier-resolved', {
    reconciliation: state.managedWslCliReconciliationStatus
  })
  // Headless PTYs must not use fallback before desktop activation swaps providers.
  await state.localPtyStartupReady
  await state.localPtyProviderStartupReady
  await registerHeadlessPtyRuntime(
    runtime,
    prepareCodexRuntimeHomeForLaunch,
    () => state.store!.getSettings(),
    (target) => state.claudeRuntimeAuth!.prepareForClaudeLaunch(target),
    state.store!,
    prepareCodexSessionResumeForLaunch,
    { onCodexHomePtySpawned: handleCodexHomePtySpawned, onPtyExit: handlePtyExit }
  )
  await runtime.refreshRestoredOrchestrationAuthority()
  await runtime.reconcileLegacyWorkerTerminals()
  // Main places unshown live terminals before any client attaches.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await placeUnshownLiveTerminalsBestEffort(runtime)
  }
  // Headless hosts need display-backed offscreen WebContents; advertise browser capability only when usable.
  if (state.headlessBrowserDisplayAvailable && !e2eHeadlessServeWithoutBrowser()) {
    runtime.setOffscreenBrowserBackend(
      new OffscreenBrowserBackend(browserManager, {
        getAgentBrowserBridge: () => state.agentBrowserBridge,
        onPageNavigated: (page) => runtime.serveBrowserPageNavigated(page)
      })
    )
  }
  publishHeadlessRuntimeGraph(runtime)
  // Register SSH before binding RPC so the first paired client sees targets.
  registerHeadlessServeSshHandlers(state.store!, runtime)
  await runtimeRpc.start().catch((error) => {
    console.error('[runtime] Failed to start headless RPC transport:', error)
    throw error
  })
  scheduleAgentLaunchRecordWarmup(null)
  // Headless phones still register/unregister tokens, though this host dispatches no push notifications.
  startDesktopPushService(runtimeRpc)
  settleDesktopActivation()
  installServeQuitHandling()
  await registerCliForHeadlessServe()
  // Headless automation cannot wait for a renderer that never opens.
  state.automations?.start()
  // Arm history-removal GC without a window so interrupted serve deletions do not leak until desktop launch.
  void scheduleAllPendingHistoryTreeRemovals()
  emitServeBrowserIdentityActionLine(getBrowserIdentityModeStatus())
  await printServeReady(serveOptions)
  const store = state.store!
  setupHeadlessServeAutoUpdater(store, {
    onBeforeUpdateQuit: () =>
      preserveStateBeforeUpdateRestart({ codexRuntimeHome: state.codexRuntimeHome, store }),
    onBeforeUpdateQuitFailure: 'abort',
    updateInstallMode: resolveUpdateInstallMode(true)
  })
}

async function launchDesktopMode(
  runtimeRpc: OrcaRuntimeRpcServer,
  shellPathReady: Promise<void>,
  desktopWindow: BrowserWindow | null,
  openMainWindow: MainProcessRuntimeLaunchOptions['openMainWindow']
): Promise<void> {
  // Retain startup failure on incomplete runtime composition.
  if (!runtimeRpc) {
    throw new Error('runtime_rpc_unavailable')
  }
  // PTY spawn gates permit parallel window/RPC startup without racing daemon-provider adoption.
  const [win, runtimeRpcStartResult] = await Promise.all([
    Promise.resolve(desktopWindow ?? openMainWindow()),
    shellPathReady
      .then(() => runtimeRpc.start())
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => {
          recordRuntimeRpcStartFailure(error)
          return { ok: false as const, error }
        }
      )
  ])
  scheduleAgentLaunchRecordWarmup(win)
  if (!runtimeRpcStartResult.ok) {
    // Await i18n only for the failure dialog; parallel launch must not show English fallback to non-English users.
    void state.mainProcessI18nReady.then(() =>
      showRuntimeRpcStartupFailureDialog(win, runtimeRpcStartResult.error)
    )
  }
  // Register before proxy await so concurrent token mints wait rather than fail provider_missing; installer requests are already guarded.
  startDesktopRelayService(runtimeRpc)
  connectDesktopConnectorCloud()
  // Create the window before awaiting proxy readiness; the request guard already fences fetches.
  await state.initialProxyApplicationReady
  // Apply persisted proxy before the push gateway's first request.
  startDesktopPushService(runtimeRpc)
  // Request macOS notification permission after reveal or the maximized window can hide it.
  win.once('show', () => {
    // Await i18n so the one-time prompt is not stuck in the English fallback.
    void state.mainProcessI18nReady.then(() => {
      // Initialization failure can leave no Store; do not throw inside Electron listeners.
      const store = state.store
      if (store && store.getOnboarding().closedAt !== null) {
        triggerStartupNotificationRegistration(store)
      }
    })
  })
}

export async function initializeMainProcessRuntimeLaunch(
  options: MainProcessRuntimeLaunchOptions
): Promise<void> {
  const runtime = state.runtime
  const shellPathHydration = state.windowsShellPathHydration
  if (!runtime || !shellPathHydration) {
    throw new Error('Runtime and shell-path services must be initialized before launch')
  }
  let serveOptions: ReturnType<typeof getServeOptions> | null = null
  try {
    serveOptions = state.isServeMode ? getServeOptions(process.argv) : null
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
    return
  }
  state.serveOptions = serveOptions
  installCloudSessionShutdownFlush()
  const runtimeRpc = installRuntimeRpc(runtime, serveOptions)
  if (!serveOptions) {
    installDesktopConnectorCloud()
  }
  const shellPathReady = shellPathHydration.whenReady()
  // Publish the same shell-PATH generation to renderer Git and terminal startup barriers.
  state.shellPathReady = shellPathReady
  // Repair known poisoned DACL before renderer initialization; the ordinary probe finishes too late to prevent its first crash.
  const aclGate = await repairKnownPoisonedInstallDirBeforeWindow({
    isServeMode: state.isServeMode || serveOptions !== null,
    userDataPath: app.getPath('userData'),
    appVersion: app.getVersion()
  })
  if (aclGate !== 'not-marked' && aclGate !== 'skipped') {
    logStartupMilestone('install-dir-acl-repair-blocking-done', { mode: aclGate })
  }
  let desktopWindow: BrowserWindow | null = null
  if (process.platform === 'win32' && app.isPackaged && !serveOptions) {
    const desktopStartup = startWindowsDesktopBeforeShellPathReady({
      bindServices: bindTerminalRuntimeStartupServices,
      openWindow: () => options.openMainWindow({ revealOnDidFinishLoad: true }),
      shellPathReady,
      startServices: startTerminalRuntimeStartupServices
    })
    desktopWindow = desktopStartup.window
  } else {
    // Start AppImage extraction before daemon host selection briefly awaits it; serve manages its own bounded extraction.
    if (!serveOptions) {
      void startAppImageCopyPreExtraction()
    }
    await shellPathReady
    bindTerminalRuntimeStartupServices(Promise.resolve(startTerminalRuntimeStartupServices()))
  }
  app.on('activate', options.handleMacAppActivation)
  if (serveOptions) {
    await launchServeMode(runtime, runtimeRpc, serveOptions)
    return
  }
  await launchDesktopMode(runtimeRpc, shellPathReady, desktopWindow, options.openMainWindow)
}
