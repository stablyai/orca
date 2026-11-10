// The control socket around a VM wake: pre-connect from the saved pairing while the VM boots, and
// treat that socket's own handshake against the woken server as the proof of a kept pairing (and
// the channel the health refresh rides), so a wake costs one connection setup, not three.
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  ensureRemoteRuntimeSharedControlConnection,
  getRemoteRuntimeSharedControlDiagnostics,
  reconnectRemoteRuntimeSharedControlConnection
} from '../ipc/runtime-environments/runtime-environment-request-connections'
import { reconnectSharedControlIfIdle } from '../ipc/runtime-environments/runtime-environment-shared-control-reconnect'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environments/runtime-environment-manual-disconnect'
import { startWakePreconnect, waitForControlReadySince } from './recipe-vm-wake-preconnect'

const CONTROL_PROOF_TIMEOUT_MS = 8_000
/** How long the health refresh waits for the control socket so it rides that socket, not a new one. */
const STATUS_RIDES_CONTROL_MS = 3_000

export function controlReadyAt(environmentId: string): number | null {
  const diagnostics = getRemoteRuntimeSharedControlDiagnostics(environmentId)
  return diagnostics?.state === 'ready' ? diagnostics.lastConnectedAt : null
}

/** Keeps the control socket dialing from the saved pairing while the VM boots (see startWakePreconnect). */
export function preconnectWokenServer(
  userDataPath: string,
  environmentId: string,
  isWaking: () => boolean
): () => void {
  return startWakePreconnect({
    ensure: () =>
      ensureRemoteRuntimeSharedControlConnection(
        environmentId,
        getPreferredPairedRuntimeConnection(resolveEnvironment(userDataPath, environmentId))
      ),
    isReady: () => controlReadyAt(environmentId) !== null,
    // Only a closed or backing-off socket is redialed; one already dialing is left to finish.
    retryNow: () =>
      reconnectSharedControlIfIdle({
        getDiagnostics: () => getRemoteRuntimeSharedControlDiagnostics(environmentId),
        reconnectNow: () => reconnectRemoteRuntimeSharedControlConnection(environmentId)
      }),
    // Bounded by readiness, the 60s cap, the wake ending (sleep, failure) or the caller stopping it.
    isWaking: () => isWaking() && !isRuntimeEnvironmentManuallyDisconnected(environmentId)
  })
}

/** Resolves once the control socket is ready on the woken server, or after a short wait. */
export function waitForWokenControl(environmentId: string, since: number): Promise<boolean> {
  return waitForControlReadySince({
    lastReadyAt: () => controlReadyAt(environmentId),
    since,
    timeoutMs: STATUS_RIDES_CONTROL_MS
  })
}

/** A control socket that authenticated after the wake began proved the kept token; else probe. */
export async function proveSavedPairingViaControl(
  environmentId: string,
  since: number,
  probe: () => Promise<void>
): Promise<void> {
  const proven = await waitForControlReadySince({
    lastReadyAt: () => controlReadyAt(environmentId),
    since,
    timeoutMs: CONTROL_PROOF_TIMEOUT_MS
  })
  if (!proven) {
    await probe()
  }
}
