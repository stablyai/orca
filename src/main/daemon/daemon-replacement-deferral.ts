import type { DaemonReplaceReason } from '../../shared/daemon-lifecycle-telemetry'
import { flushActiveSink, startSpan } from '../observability/tracer'

/**
 * A replacement the app wanted but declined because the daemon still owns live sessions.
 *
 * Why this exists: every preserve-with-live-sessions branch used to `console.warn` and return,
 * which reaches neither the trace file nor the renderer. A daemon whose TCC attribution is
 * severed then stays broken for days with nothing pointing at it (#20007). The record lets the
 * Manage Sessions remedy say why Orca did not fix it by itself.
 */
export type DaemonReplacementDeferral = {
  reason: DaemonReplaceReason
  /** null when the daemon's session inventory could not be read. */
  liveSessionCount: number | null
  observedAtMs: number
}

let latestDeferral: DaemonReplacementDeferral | null = null

export function recordDaemonReplacementDeferral(
  reason: DaemonReplaceReason,
  liveSessionCount: number | null
): DaemonReplacementDeferral {
  const deferral: DaemonReplacementDeferral = {
    reason,
    liveSessionCount,
    observedAtMs: Date.now()
  }
  latestDeferral = deferral
  try {
    startSpan('daemon.replacement_deferred', {
      attributes: {
        'daemon.replace_reason': reason,
        'daemon.live_session_count': liveSessionCount ?? 'unverifiable'
      }
    }).end()
    // Why: this decision is what a diagnostic bundle needs to explain a broken daemon, and it
    // happens on the launch path — right before a crash or quit could drop the batch.
    flushActiveSink()
  } catch {
    // Diagnostics must never fail a daemon launch.
  }
  return deferral
}

export function getDaemonReplacementDeferral(): DaemonReplacementDeferral | null {
  return latestDeferral
}

export function clearDaemonReplacementDeferral(): void {
  latestDeferral = null
}
