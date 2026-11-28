import { app, type BrowserWindow } from 'electron'
import { findBundledWebClientRoot } from '../../../shared/web-client/bundled-web-client-root'
import {
  getCanonicalUserDataPath,
  migrateMobilePairingDataToCanonicalUserDataPath
} from '../../persistence/loading-store/user-data-path'
import { OrcaRuntimeRpcServer } from '../../runtime/rpc/server/runtime-rpc'
import { resolveServePinnedBindHost } from '../serve-launch/serve-pinned-bind-host'
import { isOrcadSidecarLaunch } from '../../window/activation/foreground-activation-policy'
import type { MainWindowOpenOptions } from '../../window/main-window/main-window-contracts'
import { registerLazyMobileHandlers } from '../../ipc/register-lazy-mobile-handlers'
import { createRuntimeEnvironmentMobileRelayHosts } from '../../ipc/runtime-environments/mobile-relay/runtime-environment-mobile-relay-hosts'
import { getDesktopRelayStatus } from '../cloud-startup/main-process-relay-status'
import { startMainProcessRelayService } from '../cloud-startup/main-process-relay-startup'
import type { ServeOptions } from '../serve-launch/serve-options'
import {
  bindTerminalRuntimeStartupServices,
  startTerminalRuntimeStartupServices
} from '../pty-startup/main-process-pty-startup'
import { installCloudSessionShutdownFlush } from '../cloud-startup/cloud-session-shutdown-flush'
import { triggerStartupNotificationRegistration } from '../../ipc/notifications/startup-notification-registration'
import { startDesktopPushService } from '../cloud-startup/main-process-push-startup'
import {
  connectMainProcessConnectorCloud,
  installMainProcessConnectorCloud
} from '../cloud-startup/main-process-connector-startup'
import { mainProcessState as state } from '../main-process-state'
import { logStartupMilestone } from '../diagnostics/startup-diagnostics'
import { scheduleAgentLaunchRecordWarmup } from '../agent-accounts/agent-launch-record-warmup'
import { beginChatJournalStartup, chatJournalHostServing } from './chat-journal-startup'

type RuntimeService = NonNullable<typeof state.core.runtime>

export type MainProcessRuntimeLaunchOptions = {
  openMainWindow: (options?: MainWindowOpenOptions) => BrowserWindow | Promise<BrowserWindow>
  handleMacAppActivation: () => void
}

/** Construct the runtime RPC server with serve-specific bind and port exposure settings. */
function installRuntimeRpc(
  runtime: RuntimeService,
  serveOptions: ServeOptions | null
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
  const pinnedBindHost = resolveServePinnedBindHost({
    orcadSidecar: isOrcadSidecarLaunch(),
    serveOptions
  })
  const runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    // Pairing must use pre-setName canonical userData or restarts can lose devices.
    userDataPath: getCanonicalUserDataPath(),
    enableWebSocket: true,
    // STA-2370: desktop stays loopback until pairing; serve explicitly opts into remote access and E2E needs harness-wide bind.
    exposeNetworkByDefault: Boolean(serveOptions) || isE2E,
    ...(pinnedBindHost !== undefined ? { pinnedBindHost } : {}),
    ...(serveOptions
      ? {
          serveNetworkSources: {
            allowPublic: serveOptions.allowPublic,
            refusePublic: serveOptions.refusePublic,
            pairingAddress: serveOptions.pairingAddress
          }
        }
      : {}),
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
    webClientRoot: findBundledWebClientRoot(app.getAppPath())
  })
  state.core.runtimeRpc = runtimeRpc
  runtime.setAgentSenderPeerKey(() => runtimeRpc.getE2EEPublicKey())
  runtimeRpc.setMobileDesktopRelayHosts(createRuntimeEnvironmentMobileRelayHosts())
  registerLazyMobileHandlers(runtimeRpc, {
    getRelayStatus: getDesktopRelayStatus,
    consumePendingUnpairedDeviceAuthFailure: (webContentsId) => {
      if (
        !state.mainWindow ||
        state.mainWindow.isDestroyed() ||
        state.mainWindow.webContents.id !== webContentsId ||
        !state.core.pendingUnpairedDeviceAuthFailure
      ) {
        return false
      }
      state.core.pendingUnpairedDeviceAuthFailure = false
      return true
    }
  })
  // Pairing and revocation complete in main with no renderer call, so push them to open lists.
  runtimeRpc.setOnPairedDevicesChanged(() => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('mobile:devicesChanged')
    }
  })
  // Repeated direct-auth failures need a re-pairing explanation rather than silent nonconnection.
  runtimeRpc.setOnUnpairedDeviceAuthFailure(() => {
    // Retain the one-shot across the runtime-start/renderer-mount race.
    state.core.pendingUnpairedDeviceAuthFailure = true
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('mobile:unpairedDeviceAuthFailure')
    }
  })
  return runtimeRpc
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
        async (error: unknown) => {
          const { recordRuntimeRpcStartFailure } =
            await import('../../runtime/rpc/server/runtime-rpc-startup-failure')
          recordRuntimeRpcStartFailure(error)
          return { ok: false as const, error }
        }
      )
  ])
  scheduleAgentLaunchRecordWarmup(win)
  chatJournalHostServing()
  if (!runtimeRpcStartResult.ok) {
    // Await i18n only for the failure dialog; parallel launch must not show English fallback to non-English users.
    void state.mainProcessI18nReady.then(async () => {
      const { showRuntimeRpcStartupFailureDialog } =
        await import('../../host/electron-runtime-rpc-startup-failure-dialog')
      showRuntimeRpcStartupFailureDialog(win, runtimeRpcStartResult.error)
    })
  }
  // Register before proxy await so concurrent token mints wait rather than fail provider_missing; installer requests are already guarded.
  startMainProcessRelayService(runtimeRpc)
  connectMainProcessConnectorCloud()
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
  const runtime = state.core.runtime
  const shellPathHydration = state.windowsShellPathHydration
  if (!runtime || (process.platform === 'win32' && !shellPathHydration)) {
    throw new Error('Runtime and shell-path services must be initialized before launch')
  }
  let serveOptions: ServeOptions | null = null
  if (state.isServeMode) {
    try {
      const { getServeOptions } = await import('../serve-launch/serve-options')
      serveOptions = getServeOptions(process.argv)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      app.exit(1)
      return
    }
  }
  state.serveOptions = serveOptions
  installCloudSessionShutdownFlush()
  const runtimeRpc = installRuntimeRpc(runtime, serveOptions)
  installMainProcessConnectorCloud(serveOptions !== null)
  const shellPathReady = shellPathHydration ? shellPathHydration.whenReady() : Promise.resolve()
  // Publish the same shell-PATH generation to renderer Git and terminal startup barriers.
  state.shellPathReady = shellPathReady
  // Repair known poisoned DACL before renderer initialization; the ordinary probe finishes too late to prevent its first crash.
  if (process.platform === 'win32' && !state.isServeMode && serveOptions === null) {
    const { repairKnownPoisonedInstallDirBeforeWindow } =
      await import('../windows-install-permissions/windows-install-dir-acl-recovery')
    const aclGate = await repairKnownPoisonedInstallDirBeforeWindow({
      isServeMode: false,
      userDataPath: app.getPath('userData'),
      appVersion: app.getVersion()
    })
    if (aclGate !== 'not-marked' && aclGate !== 'skipped') {
      logStartupMilestone('install-dir-acl-repair-blocking-done', { mode: aclGate })
    }
  }
  let desktopWindow: BrowserWindow | null = null
  if (process.platform === 'win32' && app.isPackaged && !serveOptions) {
    const { startWindowsDesktopBeforeShellPathReady } =
      await import('../shell-environment/windows-desktop-shell-path-startup')
    const desktopStartup = startWindowsDesktopBeforeShellPathReady({
      bindServices: bindTerminalRuntimeStartupServices,
      openWindow: (onLoadSettled) =>
        options.openMainWindow({
          revealOnDidFinishLoad: true,
          // A failed load has nothing left to protect, so terminals should not wait out the fallback.
          loadObserver: { onLoaded: onLoadSettled, onError: onLoadSettled }
        }),
      shellPathReady,
      startServices: startTerminalRuntimeStartupServices
    })
    desktopWindow = await desktopStartup.window
  } else {
    // Start AppImage extraction before daemon host selection briefly awaits it; serve manages its own bounded extraction.
    if (!serveOptions && process.platform === 'linux') {
      void import('../../cli/appimage/appimage-copy-pre-extraction').then(
        ({ startAppImageCopyPreExtraction }) => startAppImageCopyPreExtraction()
      )
    }
    await shellPathReady
    bindTerminalRuntimeStartupServices(Promise.resolve(startTerminalRuntimeStartupServices()))
  }
  beginChatJournalStartup(runtime, serveOptions !== null)
  app.on('activate', options.handleMacAppActivation)
  if (serveOptions) {
    const { launchServeMode } = await import('./launch-serve-mode')
    await launchServeMode(runtime, runtimeRpc, serveOptions)
    return
  }
  await launchDesktopMode(runtimeRpc, shellPathReady, desktopWindow, options.openMainWindow)
}
