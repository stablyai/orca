import { translate } from '../i18n/mobile-i18n'
import type { ConnectionDiagnosticCode, ConnectionLogEmitter, ConnectionLogLevel } from './types'

// Allow ordinary scheduling delays before treating a deadline as suspended.
const SUSPENSION_SLACK_MS = 60_000

export type SocketDeadlineKind = 'connect' | 'handshake'

export type SocketDeadlineInput = {
  kind: SocketDeadlineKind
  elapsedMs: number
  timeoutMs: number
  attempt?: number
}

export type SocketDeadlineReport = {
  suspended: boolean
  level: ConnectionLogLevel
  code: ConnectionDiagnosticCode
  title: string
  detail: string
  consoleMessage: string
  consoleFields: { timeoutMs: number; elapsedMs: number; attempt?: number }
}

function elapsedLooksFrozen(elapsedMs: number, timeoutMs: number): boolean {
  return elapsedMs > timeoutMs + SUSPENSION_SLACK_MS
}

/** Distinguishes delayed timer delivery after suspension from an ordinary connect or handshake timeout. */
export function describeSocketDeadline(input: SocketDeadlineInput): SocketDeadlineReport {
  const elapsedMs = input.elapsedMs
  const suspended = elapsedLooksFrozen(elapsedMs, input.timeoutMs)
  const consoleFields = {
    timeoutMs: input.timeoutMs,
    elapsedMs,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt })
  }
  if (suspended) {
    return {
      suspended: true,
      level: 'warn',
      code: 'suspended-dial',
      title:
        input.kind === 'connect'
          ? translate(
              'connection.socketDeadlineSuspension.connectInterrupted',
              'Transport connect interrupted'
            )
          : translate(
              'connection.socketDeadlineSuspension.handshakeInterrupted',
              'Handshake interrupted'
            ),
      detail: translate(
        'connection.socketDeadlineSuspension.suspendedDetail',
        'Connection deadline delayed for {{elapsed}}; app may have been suspended. Connection state unknown, re-dialing',
        { elapsed: formatSuspendedElapsed(elapsedMs) }
      ),
      consoleMessage: `[net] ${input.kind} deadline delivery delayed`,
      consoleFields
    }
  }
  if (input.kind === 'connect') {
    return {
      suspended: false,
      level: 'error',
      code: 'connect-timeout',
      title: translate(
        'connection.socketDeadlineSuspension.connectTimeout',
        'Transport connect timeout'
      ),
      detail: translate(
        'connection.socketDeadlineSuspension.connectTimeoutDetail',
        'Transport did not open within {{seconds}}s',
        { seconds: input.timeoutMs / 1000 }
      ),
      consoleMessage: '[net] connect-timeout fired (onopen never arrived)',
      consoleFields
    }
  }
  return {
    suspended: false,
    level: 'error',
    code: 'handshake-timeout',
    title: translate('connection.socketDeadlineSuspension.handshakeTimeout', 'Handshake timeout'),
    detail: translate(
      'connection.socketDeadlineSuspension.handshakeTimeoutDetail',
      'No e2ee_ready/e2ee_authenticated within {{seconds}}s',
      { seconds: input.timeoutMs / 1000 }
    ),
    consoleMessage: '[net] handshake-timeout fired (e2ee_authenticated never arrived)',
    consoleFields
  }
}

export function reportSocketDeadline(
  input: SocketDeadlineInput,
  emitLog: ConnectionLogEmitter,
  close: () => void
): void {
  const report = describeSocketDeadline(input)
  console.log(report.consoleMessage, report.consoleFields)
  emitLog(report.level, report.title, report.detail, { code: report.code })
  close()
}

function formatSuspendedElapsed(elapsedMs: number): string {
  const totalMinutes = Math.max(1, Math.round(elapsedMs / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0 && minutes > 0) {
    return `${hours}h${minutes}m`
  }
  if (hours > 0) {
    return `${hours}h`
  }
  return `${minutes}m`
}
