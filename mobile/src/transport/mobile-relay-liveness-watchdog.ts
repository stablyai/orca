import { RpcSessionLivenessWatchdog } from './rpc-session-liveness-watchdog'
import type { ConnectionLogSink } from './types'

const RELAY_PROBE_TIMEOUT_MS = 4_000
const RELAY_MISSED_PROBE_LIMIT = 2
const RELAY_FOREGROUND_PROBE_MIN_INTERVAL_MS = 10_000
let relayLivenessSessionSequence = 0

export function createMobileRelayLivenessWatchdog(args: {
  onLog?: ConnectionLogSink
  sendProbe: () => boolean
  terminate: () => void
}): RpcSessionLivenessWatchdog {
  let logSequence = 0
  const sessionId = `${Date.now().toString(36)}-${(++relayLivenessSessionSequence).toString(36)}`
  return new RpcSessionLivenessWatchdog({
    transport: 'relay',
    idleProbeMs: null,
    probeTimeoutMs: RELAY_PROBE_TIMEOUT_MS,
    missedProbeLimit: RELAY_MISSED_PROBE_LIMIT,
    voluntaryProbeMinIntervalMs: RELAY_FOREGROUND_PROBE_MIN_INTERVAL_MS,
    sendProbe: args.sendProbe,
    onTimeout: (evidence) => {
      args.onLog?.({
        id: `relay-liveness-${sessionId}-${++logSequence}`,
        ts: Date.now(),
        level: 'error',
        code: 'liveness-timeout',
        path: 'relay',
        message: 'Relay health check failed',
        detail: `${evidence.reason}; ${evidence.missedProbes}/${evidence.missedProbeLimit} probes missed; last authenticated activity ${evidence.lastInboundAgeMs}ms ago`
      })
    },
    terminate: args.terminate
  })
}
