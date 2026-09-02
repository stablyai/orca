import { app, powerMonitor, type BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { getOrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import {
  getCanonicalUserDataPath,
  migrateMobilePairingDataToCanonicalUserDataPath
} from '../persistence'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { registerMobileHandlers } from '../ipc/mobile'
import { getLocalPtyProvider, registerHeadlessPtyRuntime } from '../ipc/pty'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { OffscreenBrowserBackend } from '../browser/offscreen-browser-backend'
import { browserManager } from '../browser/browser-manager'
import { DesktopRelayService } from '../runtime/relay/desktop-relay-service'
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
import { registerServeSignalHandlers } from './serve-signal-handlers'
import { settleServeDesktopActivation } from './serve-desktop-activation'
import {
  recordRuntimeRpcStartFailure,
  showRuntimeRpcStartupFailureDialog
} from '../runtime/runtime-rpc-startup-failure'
import { CliInstaller } from '../cli/cli-installer'
import { installLinuxBareOrcaDispatcher } from '../cli/linux-bare-orca-dispatcher'
import { scheduleAllPendingHistoryTreeRemovals } from '../terminal-history-deletion'
import { triggerStartupNotificationRegistration } from '../ipc/startup-notification-registration'
import { mainProcessState as state } from './main-process-state'
import { logStartupMilestone } from './startup-diagnostics'

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

function installRuntimeRpc(
  runtime: RuntimeService,
  serveOptions: ReturnType<typeof getServeOptions> | null
): OrcaRuntimeRpcServer {
  // Why: existing installs may have pairing creds under the late app.getPath('userData'); copy them forward before switching to the canonical path.
  migrateMobilePairingDataToCanonicalUserDataPath(app.getPath('userData'))
  // Why: parallel E2E Electron instances would race the fixed port (EADDRINUSE); port 0 gives each a random OS-assigned port.
  const isE2E = Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
  const requestedE2EWsPort = process.env.ORCA_E2E_RUNTIME_WS_PORT
  const e2eWsPort = requestedE2EWsPort === undefined ? 0 : Number(requestedE2EWsPort)
  if (isE2E && (!Number.isInteger(e2eWsPort) || e2eWsPort < 0 || e2eWsPort > 65_535)) {
    throw new Error(`Invalid ORCA_E2E_RUNTIME_WS_PORT value: ${requestedE2EWsPort}`)
  }
  // Why: pin dev to 6769 so `pnpm dev` doesn't race packaged Orca on 6768 and fall back to a random port, breaking deterministic mobile pairing/repro (STA-1511).
  const devWsPort = is.dev && !isE2E ? 6769 : undefined
  const runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    // Why: mobile pairing needs the stable pre-setName() path (getCanonicalUserDataPath), not a late app.getPath('userData') that drops paired devices across restarts.
    userDataPath: getCanonicalUserDataPath(),
    enableWebSocket: true,
    // Why: STA-2370 — the desktop app binds the WS listener to loopback until the user pairs a device;
    // `orca serve` is an explicit remote opt-in, and E2E keeps the wide bind its harness connects over.
    exposeNetworkByDefault: Boolean(serveOptions) || isE2E,
    ...(isE2E ? { wsPort: e2eWsPort } : {}),
    ...(devWsPort !== undefined ? { wsPort: devWsPort } : {}),
    ...(serveOptions?.wsPort !== undefined
      ? {
          wsPort: serveOptions.wsPort,
          // Why: only explicit `orca serve --port` overrides a stale STA-1511 fallback (issue #8535); default/dev stay fallback-first for pairing stability.
          preferPinnedWsPort: true
        }
      : {}),
    webClientRoot: getBundledWebClientRoot()
  })
  state.runtimeRpc = runtimeRpc
  registerMobileHandlers(runtimeRpc, {
    getRelayStatus: () => state.desktopRelayStatus,
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
  // Why: repeated direct auth failures otherwise look like a client that never connects; point users to re-pairing.
  runtimeRpc.setOnUnpairedDeviceAuthFailure(() => {
    // Why: runtime startup races renderer mount; retain the one-shot until the listener consumes it.
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
  // Why: give managed WSL launchers a brief chance to migrate before headless PTYs go live, without slow repairs withholding all RPC readiness.
  logStartupMilestone('wsl-cli-barrier-start')
  await state.managedWslCliStartupBarrierReady
  logStartupMilestone('wsl-cli-barrier-resolved', {
    reconciliation: state.managedWslCliReconciliationStatus
  })
  // Why: headless PTYs must not start on the fallback provider, then get swept when an activated renderer registers desktop lifecycle handlers.
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
  // Why: headless servers can't mount <webview> panes; use offscreen WebContents, gated on a real display so browser.headless.v1 stays honest.
  if (state.headlessBrowserDisplayAvailable) {
    runtime.setOffscreenBrowserBackend(
      new OffscreenBrowserBackend(browserManager, {
        getAgentBrowserBridge: () => state.agentBrowserBridge
      })
    )
  }
  // Why: headless servers have no renderer graph publisher; publish an explicit empty graph so status clients see a ready server.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  await runtimeRpc.start().catch((error) => {
    console.error('[runtime] Failed to start headless RPC transport:', error)
    throw error
  })
  settleDesktopActivation()
  // Why: every attempt must reach app.quit(); a page beforeunload can veto an earlier signal.
  registerServeSignalHandlers(process, () => app.quit())
  // Why: headless serve has no renderer to run the normal cli:install flow; do it here for macOS/Linux only (Windows-excluded: install() only mutates registry PATH, not child terminals).
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      // Why: serve is headless — a fallback osascript admin prompt would hang it; skip elevation since ~/.local/bin needs none.
      const cliStatus = await new CliInstaller({
        privilegedRunner: async () => {
          throw new Error('serve CLI auto-install must not request administrator privileges')
        }
      }).install()
      console.log(
        `[serve] orca CLI install: ${cliStatus.state}${cliStatus.commandPath ? ` (${cliStatus.commandPath})` : ''}`
      )
    } catch (error) {
      console.warn(
        '[serve] orca CLI install skipped:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  // Why: Linux CLI installs as `orca-ide`, but the Claude Team launcher invokes bare `orca`; drop a ~/.local/bin dispatcher (ahead of /usr/bin) so it resolves. Best-effort.
  if (process.platform === 'linux' && app.isPackaged && process.resourcesPath) {
    try {
      const dispatcher = await installLinuxBareOrcaDispatcher({
        resourcesPath: process.resourcesPath
      })
      console.log(
        `[serve] bare orca dispatcher ${dispatcher.state}: ${dispatcher.dispatcherPath}` +
          `${dispatcher.target ? ` -> ${dispatcher.target}` : ''}`
      )
    } catch (error) {
      console.warn(
        '[serve] bare orca dispatcher install skipped:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  // Why: headless serve never opens a renderer, so arm scheduled automation dispatch here.
  state.automations?.start()
  // Why: serve deletes worktrees too, and the history GC that normally drains delete tombstones is
  // armed from the main window — without this, a quit mid-removal leaks the tree until a desktop launch.
  scheduleAllPendingHistoryTreeRemovals()
  await printServeReady(serveOptions)
}

async function launchDesktopMode(
  runtimeRpc: OrcaRuntimeRpcServer,
  shellPathReady: Promise<void>,
  desktopWindow: BrowserWindow | null,
  openMainWindow: MainProcessRuntimeLaunchOptions['openMainWindow']
): Promise<void> {
  // Preserve the pre-split startup failure contract if composition ever hands
  // this phase an incomplete runtime graph.
  if (!runtimeRpc) {
    throw new Error('runtime_rpc_unavailable')
  }
  // Why: window and RPC startup run in parallel; registerPtyHandlers gates PTY spawns so RPC binds without racing the daemon provider swap.
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
  if (!runtimeRpcStartResult.ok) {
    void showRuntimeRpcStartupFailureDialog(win, runtimeRpcStartResult.error)
  }
  const cloudAuth = getOrcaCloudAuthConfig()
  if (cloudAuth.configured) {
    try {
      const relayService = new DesktopRelayService({
        authConfig: cloudAuth.config,
        userDataPath: getProfileUserDataPath(),
        appVersion: app.getVersion(),
        runtimeRpc,
        onStatus: (status) => {
          state.desktopRelayStatus = status
          state.mainWindow?.webContents.send('mobile:relayStatusChanged', status)
        }
      })
      state.desktopRelayService = relayService
      runtimeRpc.setMobileRelayPairingProvider({
        createPairingRelay: (relayDeviceId) => relayService.createPairingRelay(relayDeviceId),
        onDeviceRevokeQueued: (item) => relayService.onDeviceRevokeQueued(item),
        onDemandStateChanged: () => relayService.demandStateChanged(),
        getEndpoints: (context, params) => relayService.getEndpoints(context, params),
        provisionRelay: (context, params) => relayService.provisionRelay(context, params)
      })
      relayService.start()
      // Why: sleeping past relay-token expiry kills the broker with no retry
      // timer; resume is the moment that state becomes recoverable.
      powerMonitor.on('resume', () => state.desktopRelayService?.ensureLive())
    } catch (error) {
      console.warn(
        '[relay] Desktop relay startup unavailable:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  // Why: macOS notification permission dialog must fire after the window is shown, else it's hidden behind the maximized window.
  win.once('show', () => {
    // Why: store can be null if init failed earlier; bail rather than throw inside an Electron event listener.
    const store = state.store
    if (store && store.getOnboarding().closedAt !== null) {
      triggerStartupNotificationRegistration(store)
    }
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
  const runtimeRpc = installRuntimeRpc(runtime, serveOptions)
  const shellPathReady = shellPathHydration.whenReady()
  // Why published: the renderer's git-environment barrier must fence on the same
  // generation the terminal startup services wait for, not a later re-read.
  state.shellPathReady = shellPathReady
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
