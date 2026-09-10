import { redactConnectionLogText } from '../diagnostics/connection-log-redaction'
import type { ConnectionLogEntry, ConnectionLogSink, PairingStage } from './types'

const MAX_PAIRING_LOG_ENTRIES = 64
const MAX_PAIRING_ERROR_LENGTH = 240

export const PAIRING_STAGE_LABELS: Record<PairingStage, string> = {
  bundle_readiness: 'Bundle readiness',
  transport_connection: 'Transport connection',
  host_authentication: 'Host authentication',
  relay_reconciliation: 'Relay reconciliation',
  profile_persistence: 'Profile persistence',
  client_refresh: 'Cached client refresh',
  route_commit: 'Destination route'
}

const PAIRING_STAGE_SUCCESS_MESSAGES: Record<PairingStage, string> = {
  bundle_readiness: 'Bundle ready',
  transport_connection: 'Transport connected',
  host_authentication: 'Host authenticated',
  relay_reconciliation: 'Relay reconciled',
  profile_persistence: 'Profile persisted',
  client_refresh: 'Cached client refreshed',
  route_commit: 'Destination route committed'
}

export class PairingStageError extends Error {
  readonly stage: PairingStage
  readonly originalCode: string

  constructor(stage: PairingStage, originalCode: string, message: string) {
    super(message)
    this.name = 'PairingStageError'
    this.stage = stage
    this.originalCode = originalCode
  }
}

export type PairingStageReporter = {
  readonly current: PairingStage
  begin(stage: PairingStage, detail?: string): void
  complete(stage: PairingStage, detail?: string): void
  fail(error: unknown): PairingStageError
}

export function createPairingStageReporter(args: {
  onLog?: ConnectionLogSink
  onStageChange?: (stage: PairingStage) => void
  now: () => number
}): PairingStageReporter {
  let current: PairingStage = 'bundle_readiness'
  let sequence = 0

  const emit = (
    stage: PairingStage,
    level: ConnectionLogEntry['level'],
    message: string,
    detail?: string
  ): void => {
    args.onLog?.({
      id: `pairing-stage-${sequence++}`,
      ts: args.now(),
      level,
      message,
      ...(detail ? { detail: boundAndRedact(detail) } : {}),
      pairingStage: stage
    })
  }

  return {
    get current() {
      return current
    },
    begin(stage, detail) {
      current = stage
      args.onStageChange?.(stage)
      emit(stage, 'info', PAIRING_STAGE_LABELS[stage], detail)
    },
    complete(stage, detail) {
      current = stage
      args.onStageChange?.(stage)
      emit(stage, 'success', PAIRING_STAGE_SUCCESS_MESSAGES[stage], detail)
    },
    fail(error) {
      if (error instanceof PairingStageError) {
        return error
      }
      const identity = pairingErrorIdentity(error)
      const pairingError = new PairingStageError(current, identity.code, identity.message)
      emit(
        current,
        'error',
        `${PAIRING_STAGE_LABELS[current]} failed`,
        `${identity.code}: ${identity.message}`
      )
      return pairingError
    }
  }
}

export function appendBoundedPairingLog(
  entries: readonly ConnectionLogEntry[],
  entry: ConnectionLogEntry
): ConnectionLogEntry[] {
  return [...entries, entry].slice(-MAX_PAIRING_LOG_ENTRIES)
}

export function pairingFailureMessage(error: unknown, timedOut: boolean): string {
  if (timedOut) {
    return 'Pairing timed out. Check the failed stage in the log, then try again.'
  }
  if (error instanceof PairingStageError) {
    return `${PAIRING_STAGE_LABELS[error.stage]} failed (${error.originalCode}). Check the log, then try again.`
  }
  return 'Pairing failed. Check the log, then try again.'
}

function pairingErrorIdentity(error: unknown): { code: string; message: string } {
  if (isErrorWithCode(error)) {
    return { code: boundAndRedact(error.code), message: boundAndRedact(error.message) }
  }
  const message = error instanceof Error ? error.message : String(error)
  const embeddedCode = message.match(/^([A-Za-z][A-Za-z0-9_.-]{1,63}):\s*/)?.[1]
  return {
    code: boundAndRedact(embeddedCode ?? (error instanceof Error ? error.name : 'unknown_error')),
    message: boundAndRedact(message)
  }
}

function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  )
}

function boundAndRedact(value: string): string {
  const redacted = redactConnectionLogText(value.replaceAll(/\s+/g, ' ').trim())
  return redacted.length > MAX_PAIRING_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_PAIRING_ERROR_LENGTH - 1)}…`
    : redacted
}
