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
      title: input.kind === 'connect' ? 'WebSocket connect interrupted' : 'Handshake interrupted',
      detail: `Connection deadline delayed for ${formatSuspendedElapsed(elapsedMs)}; app may have been suspended. Connection state unknown, re-dialing`,
      consoleMessage: `[net] ${input.kind} deadline delivery delayed`,
      consoleFields
    }
  }
  if (input.kind === 'connect') {
    return {
      suspended: false,
      level: 'error',
      code: 'connect-timeout',
      title: 'WebSocket connect timeout',
      detail: `No TCP/WS handshake within ${input.timeoutMs / 1000}s — endpoint unreachable?`,
      consoleMessage: '[net] connect-timeout fired (onopen never arrived)',
      consoleFields
    }
  }
  return {
    suspended: false,
    level: 'error',
    code: 'handshake-timeout',
    title: 'Handshake timeout',
    detail: `No e2ee_ready/e2ee_authenticated within ${input.timeoutMs / 1000}s`,
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
