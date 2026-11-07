import { app } from 'electron'
import { registerMobileHandlers } from '../ipc/mobile'
import { createRuntimeEnvironmentMobileRelayHosts } from '../ipc/runtime-environments/runtime-environment-mobile-relay-hosts'
import {
  getCanonicalUserDataPath,
  migrateMobilePairingDataToCanonicalUserDataPath
} from '../persistence/loading-store/user-data-path'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import { isOrcadSidecarLaunch } from '../window/foreground-activation-policy'
import { getDesktopRelayStatus } from './main-process-relay-status'
import { getBundledWebClientRoot } from './main-process-serve'
import { mainProcessState as state } from './main-process-state'
import type { ServeOptions } from './serve-options'
import { resolveServePinnedBindHost } from './serve-pinned-bind-host'

/** Install desktop RPC with serve-specific binds and a relay subscription detached when RPC stops. */
export function installRuntimeRpc(
  runtime: OrcaRuntimeService,
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
  const profileStore = state.store!
  const runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    // Pairing must use pre-setName canonical userData or restarts can lose devices.
    userDataPath: getCanonicalUserDataPath(),
    irohRelayUrl: profileStore.getSettings().mobileIrohRelayUrl,
    onStop: () => unsubscribeIrohRelay(),
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
    webClientRoot: getBundledWebClientRoot()
  })
  const unsubscribeIrohRelay = profileStore.onSettingsChanged((updates, settings) => {
    if ('mobileIrohRelayUrl' in updates) {
      void runtimeRpc.setIrohRelayUrl(settings.mobileIrohRelayUrl).catch(() => {
        console.warn('[runtime-rpc] Could not apply the saved iroh relay preference')
      })
    }
  })
  state.runtimeRpc = runtimeRpc
  runtime.setAgentSenderPeerKey(() => runtimeRpc.getE2EEPublicKey())
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
