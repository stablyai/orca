import type { PairedRuntimeConnection } from '../shared/paired-runtime-connection'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../shared/remote-runtime-shared-control-types'
import { resolveEnvironment } from '../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../shared/runtime-environments'

/** Result of verifying a runtime's control connection: `{ ok: true }`, or the
 * terminal connection state after the bounded wait expired. */
export type EphemeralVmRuntimeControlConnectionWake =
  | { ok: true }
  | { ok: false; connectionState: string }

/** How long a wake waits for a repaired connection to reach `ready`. */
export const EPHEMERAL_VM_WAKE_READY_TIMEOUT_MS = 10_000
/** Poll cadence while waiting for a repaired connection to reach `ready`. */
export const EPHEMERAL_VM_WAKE_POLL_INTERVAL_MS = 250
/** How long a `ready` connection gets to answer the wake probe before it is refreshed. */
export const EPHEMERAL_VM_WAKE_PROBE_TIMEOUT_MS = 5_000

/**
 * Verify (and repair) a running ephemeral VM runtime's control connection.
 *
 * Why: `ephemeralVm:resumeWorkspace` is the wake verb behind every sidebar
 * workspace open, and for a runtime that never left `running` it returned the
 * record without touching the transport. A runtime whose cached connection
 * went wedged (host rebooted under it, NAT dropped the tunnel, the serve
 * restarted out from under the socket) then surfaced as a silent workspace
 * spinner: no recipe ran, no request left the app, and only an app restart
 * rehydrated. This check probes a `ready` connection and refreshes it when the
 * probe goes unanswered, forces a reconnect when the cached connection is not
 * ready, waits a bounded time for it, and reports the terminal state so the
 * caller can surface a real error instead of an indefinite spinner.
 */
export async function ensureEphemeralVmRuntimeControlConnection(args: {
  userDataPath: string
  runtimeEnvironmentId: string
  getDiagnostics: (environmentId: string) => RemoteRuntimeSharedConnectionDiagnostics | null
  reconnect: (environmentId: string) => void
  ensureConnection: (environmentId: string, pairedConnection: PairedRuntimeConnection) => void
  /** Sends a cheap request over the cached connection; settles ok only on a server reply. */
  probe: (
    environmentId: string,
    pairedConnection: PairedRuntimeConnection,
    timeoutMs: number
  ) => Promise<unknown>
  /** Replaces the transport even when it reads `ready`. */
  forceRefresh: (environmentId: string) => void
  resolvePairedConnection?: (userDataPath: string, selector: string) => PairedRuntimeConnection
  waitForReadyTimeoutMs?: number
  pollIntervalMs?: number
  probeTimeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<EphemeralVmRuntimeControlConnectionWake> {
  const { userDataPath, runtimeEnvironmentId, getDiagnostics, reconnect, ensureConnection } = args
  const waitForReadyTimeoutMs = args.waitForReadyTimeoutMs ?? EPHEMERAL_VM_WAKE_READY_TIMEOUT_MS
  const pollIntervalMs = args.pollIntervalMs ?? EPHEMERAL_VM_WAKE_POLL_INTERVAL_MS
  const probeTimeoutMs = args.probeTimeoutMs ?? EPHEMERAL_VM_WAKE_PROBE_TIMEOUT_MS
  const now = args.now ?? Date.now
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const resolvePairedConnection =
    args.resolvePairedConnection ??
    ((path: string, selector: string) =>
      getPreferredPairedRuntimeConnection(resolveEnvironment(path, selector)))

  const current = getDiagnostics(runtimeEnvironmentId)
  if (current?.state === 'ready') {
    // Why: a half-open socket reads `ready` until the liveness monitor notices, so prove it answers.
    const answered = await args
      .probe(
        runtimeEnvironmentId,
        resolvePairedConnection(userDataPath, runtimeEnvironmentId),
        probeTimeoutMs
      )
      .then(
        () => true,
        () => false
      )
    if (answered) {
      return { ok: true }
    }
    args.forceRefresh(runtimeEnvironmentId)
  } else if (!current) {
    // No cached connection. ensureConnection itself refuses when the
    // environment is manually disconnected, so the bounded wait below reports
    // that state instead of fighting the user's own disconnect.
    ensureConnection(
      runtimeEnvironmentId,
      resolvePairedConnection(userDataPath, runtimeEnvironmentId)
    )
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
