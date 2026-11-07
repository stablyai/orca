import { app, type BrowserWindow } from 'electron'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { placeUnshownLiveTerminalsBestEffort } from '../runtime/terminal/adoption/unshown-live-terminal-placement'
import type { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import { installRuntimeRpc } from './main-process-runtime-rpc'
import { getLocalPtyProvider } from '../ipc/pty/provider/registry'
import { registerHeadlessPtyRuntime } from '../ipc/pty/register-headless-runtime'
import { LocalPtyProvider } from '../providers/local-pty/local-pty-provider'
import { publishHeadlessRuntimeGraph } from '../runtime/headless-runtime-graph'
import { OffscreenBrowserBackend } from '../browser/backends/offscreen-browser-backend'
import { browserManager } from '../browser/browser-manager'
import { startDesktopRelayService } from './main-process-relay-startup'
import { getServeOptions, printServeReady } from './main-process-serve'
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
} from '../runtime/rpc/server/runtime-rpc-startup-failure'
import { registerCliForHeadlessServe } from './serve-cli-registration'
import { startAppImageCopyPreExtraction } from '../cli/appimage-copy-pre-extraction'
import { scheduleAllPendingHistoryTreeRemovals } from '../pty/history/terminal-history-deletion'
import { triggerStartupNotificationRegistration } from '../ipc/startup-notification-registration'
import { startDesktopPushService } from './main-process-push-startup'
import {
  connectDesktopConnectorCloud,
  installDesktopConnectorCloud
} from './main-process-connector-startup'
import { mainProcessState as state } from './main-process-state'
import { logStartupMilestone } from './startup-diagnostics'
import { setupHeadlessServeAutoUpdater } from '../window/main-window-updater'
import { preserveStateBeforeUpdateRestart } from '../updater/update-restart-preservation'
import { resolveUpdateInstallMode } from '../updater/updater-service'
import { scheduleAgentLaunchRecordWarmup } from './agent-launch-record-warmup'
import { emitServeBrowserIdentityActionLine } from '../server/serve-stdout-boundary'
import { getBrowserIdentityModeStatus } from '../browser/identity/browser-identity-mode-store'

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
