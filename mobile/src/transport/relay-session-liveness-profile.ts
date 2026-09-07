import {
  RpcSessionLivenessWatchdog,
  type LivenessTimeoutEvidence
} from './rpc-session-liveness-watchdog'
import type { ConnectionLogSink } from './types'

// Ordinary foreground checks: two 4s misses, at most one voluntary probe per 10s.
const RELAY_PROBE = { timeoutMs: 4_000, missedProbeLimit: 2, minIntervalMs: 10_000 }
// A socket that died while the process was suspended must be admitted before the
// user reads the screen as broken. Two 2s misses, not one: the first frame after a
// resume rides a cold radio, and a single slow answer is not proof of a dead link.
const RELAY_RESUME_PROBE = { timeoutMs: 2_000, missedProbeLimit: 2 }
// Foreground-only sweep so a silently-dead relay surfaces without a user action.
const RELAY_IDLE_PROBE_MS = 25_000

// The relay session's probe budget and its timeout log line, kept apart from the
// session so the dial/RPC code and the liveness policy can each be read on its own.
export function createRelaySessionLivenessWatchdog(args: {
  isForeground?: () => boolean
  sendProbe: () => boolean
  terminate: () => void
  onLog?: ConnectionLogSink
  nextLogId: () => string
}): RpcSessionLivenessWatchdog {
  return new RpcSessionLivenessWatchdog({
    transport: 'relay',
    idleProbeMs: RELAY_IDLE_PROBE_MS,
    probeTimeoutMs: RELAY_PROBE.timeoutMs,
    missedProbeLimit: RELAY_PROBE.missedProbeLimit,
    voluntaryProbeMinIntervalMs: RELAY_PROBE.minIntervalMs,
    urgentProbeTimeoutMs: RELAY_RESUME_PROBE.timeoutMs,
    urgentMissedProbeLimit: RELAY_RESUME_PROBE.missedProbeLimit,
    shouldIdleProbe: () => args.isForeground?.() ?? true,
    sendProbe: args.sendProbe,
    onTimeout: (evidence: LivenessTimeoutEvidence) => {
      // Why: the watchdog terminates the session right after this returns. A sink
      // that throws must not keep a dead relay 'connected'.
      try {
        args.onLog?.({
          id: args.nextLogId(),
          ts: Date.now(),
          level: 'error',
          code: 'liveness-timeout',
          path: 'relay',
          message: 'Relay health check failed',
          detail: `${evidence.reason}; ${evidence.missedProbes}/${evidence.missedProbeLimit} probes missed; last authenticated activity ${evidence.lastInboundAgeMs}ms ago`
        })
      } catch {
        // Diagnostics only.
      }
    },
    terminate: args.terminate
  })
}
