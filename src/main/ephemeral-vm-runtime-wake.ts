import type { PairingOffer } from '../shared/pairing'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../shared/remote-runtime-shared-control-types'
import { resolveEnvironmentPairingOffer } from '../shared/runtime-environment-store'

export type EphemeralVmRuntimeControlConnectionWake =
  | { ok: true }
  | { ok: false; connectionState: string }

export const EPHEMERAL_VM_WAKE_READY_TIMEOUT_MS = 10_000
export const EPHEMERAL_VM_WAKE_POLL_INTERVAL_MS = 250

/**
 * Verify (and repair) a running ephemeral VM runtime's control connection.
 *
 * Why: `ephemeralVm:resumeWorkspace` is the wake verb behind every sidebar
 * workspace open, and for a runtime that never left `running` it returned the
 * record without touching the transport. A runtime whose cached connection
 * went wedged (host rebooted under it, NAT dropped the tunnel, the serve
 * restarted out from under the socket) then surfaced as a silent workspace
 * spinner: no recipe ran, no request left the app, and only an app restart
 * rehydrated. This check forces a reconnect when the cached connection is not
 * ready, waits a bounded time for it, and reports the terminal state so the
 * caller can surface a real error instead of an indefinite spinner.
 */
export async function ensureEphemeralVmRuntimeControlConnection(args: {
  userDataPath: string
  runtimeEnvironmentId: string
  getDiagnostics: (environmentId: string) => RemoteRuntimeSharedConnectionDiagnostics | null
  reconnect: (environmentId: string) => void
  ensureConnection: (environmentId: string, pairing: PairingOffer) => void
  resolvePairing?: (userDataPath: string, selector: string) => PairingOffer
  waitForReadyTimeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<EphemeralVmRuntimeControlConnectionWake> {
  const { userDataPath, runtimeEnvironmentId, getDiagnostics, reconnect, ensureConnection } = args
  const waitForReadyTimeoutMs = args.waitForReadyTimeoutMs ?? EPHEMERAL_VM_WAKE_READY_TIMEOUT_MS
  const pollIntervalMs = args.pollIntervalMs ?? EPHEMERAL_VM_WAKE_POLL_INTERVAL_MS
  const now = args.now ?? Date.now
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const resolvePairing = args.resolvePairing ?? resolveEnvironmentPairingOffer

  const current = getDiagnostics(runtimeEnvironmentId)
  if (current?.state === 'ready') {
    return { ok: true }
  }
  if (!current) {
    // No cached connection. ensureConnection itself refuses when the
    // environment is manually disconnected, so the bounded wait below reports
    // that state instead of fighting the user's own disconnect.
    ensureConnection(runtimeEnvironmentId, resolvePairing(userDataPath, runtimeEnvironmentId))
  } else {
    reconnect(runtimeEnvironmentId)
  }

  const deadline = now() + waitForReadyTimeoutMs
  for (;;) {
    await sleep(pollIntervalMs)
    const diagnostics = getDiagnostics(runtimeEnvironmentId)
    if (diagnostics?.state === 'ready') {
      return { ok: true }
    }
    if (now() >= deadline) {
      return { ok: false, connectionState: diagnostics?.state ?? 'no_connection' }
    }
  }
}
