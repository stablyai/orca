import { RelayOuterError } from './mobile-relay-e2ee-link'
import type { ConnectionLogLevel, ConnectionLogSink } from './types'

export type PairingRelayLogger = (
  level: ConnectionLogLevel,
  message: string,
  detail?: string
) => void

// Why: every relay dial and recovery attempt builds its own logger but they all
// feed one list, so the id sequence has to be process-wide to stay a unique key.
let sequence = 0

export function createPairingRelayLogger(onLog?: ConnectionLogSink): PairingRelayLogger {
  if (!onLog) {
    return () => {}
  }
  return (level, message, detail) => {
    onLog({ id: `relay-pair-log-${++sequence}`, ts: Date.now(), level, message, detail })
  }
}

export function pairingRelayErrorDetail(error: unknown): string {
  if (error instanceof RelayOuterError) {
    return `relay close code ${error.code}`
  }
  const failure = error instanceof Error ? error : new Error(String(error))
  return `${failure.name}: ${String(failure.message).slice(0, 80)}`
}
