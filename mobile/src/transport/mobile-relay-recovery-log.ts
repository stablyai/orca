import type { ConnectionLogSink } from './types'

export type RelayRecoveryLog = (message: string, detail?: string) => void

// Why: relay recovery failed silently in production for weeks; every decision
// must reach logcat and the in-app connection log.
export function createRelayRecoveryLog(
  now: () => number,
  onLog?: ConnectionLogSink
): RelayRecoveryLog {
  let sequence = 0
  return (message, detail) => {
    console.log(`[relay] ${message}`, detail ?? '')
    onLog?.({
      id: `relay-${++sequence}`,
      ts: now(),
      level: 'info',
      message: `Relay: ${message}`,
      ...(detail ? { detail } : {})
    })
  }
}
