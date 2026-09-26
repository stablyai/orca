import type { BrowserWindow } from 'electron'
import { getCanonicalUserDataPath } from '../persistence'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import {
  readWsPinnedBindConfig,
  WS_PINNED_BIND_CONFIG_FILE,
  wsPinnedBindServerOptions,
  type WsPinnedBindServerOptions
} from '../runtime/rpc/ws-pinned-bind-config'
import { showPinnedWebSocketBindFailureDialog } from '../runtime/runtime-rpc-startup-failure'
import { mainProcessState as state } from './main-process-state'

// Why desktop only: `orca serve` has its own --port contract and E2E owns its ports.
export function desktopPinnedWsBindOptions(isServeOrE2E: boolean): WsPinnedBindServerOptions {
  if (isServeOrE2E) {
    return {}
  }
  return wsPinnedBindServerOptions(readWsPinnedBindConfig(getCanonicalUserDataPath()))
}

// Why: only an operator-pinned bind records a failure; it stays down rather than relocating, so say so.
export function surfacePinnedWsBindFailure(
  win: BrowserWindow,
  runtimeRpc: OrcaRuntimeRpcServer
): void {
  const failure = runtimeRpc.getWebSocketStartFailure()
  if (failure === null) {
    return
  }
  // Why gated: same i18n wait as the RPC startup-failure dialog, so the text is localized.
  void state.mainProcessI18nReady.then(() =>
    showPinnedWebSocketBindFailureDialog(win, failure, WS_PINNED_BIND_CONFIG_FILE)
  )
}
