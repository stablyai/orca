import type { ConnectionDiagnosticCode, ConnectionLogEmitter, ConnectionLogLevel } from './types'

/**
 * A timer that fires this far past its budget was frozen with the process.
 * A live 12s connect timeout still lands near its budget, so it stays a host miss.
 */
const SUSPENSION_SLACK_MS = 60_000

export type SocketDeadlineKind = 'connect' | 'handshake'

export type SocketDeadlineInput = {
  kind: SocketDeadlineKind
  armedAtMs: number
  firedAtMs: number
  timeoutMs: number
  attempt?: number
  /** Elapsed on a clock that ignores wall-clock steps. Omitted keeps the wall-clock reading. */
  monotonicElapsedMs?: number
  /** The app left the foreground while this deadline was armed. */
  leftForeground?: boolean
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
  const elapsedMs = input.firedAtMs - input.armedAtMs
  const wallFrozen = elapsedLooksFrozen(elapsedMs, input.timeoutMs)
  const monotonicFrozen =
    input.monotonicElapsedMs !== undefined &&
    elapsedLooksFrozen(input.monotonicElapsedMs, input.timeoutMs)
  // A foreground loss supports suspension only when at least one clock also ran long.
  // Without an AppState event, both clocks must run long to distinguish a wall-clock step.
  const suspended =
    (input.leftForeground === true && (wallFrozen || monotonicFrozen)) ||
    (input.monotonicElapsedMs === undefined ? wallFrozen : wallFrozen && monotonicFrozen)
  const consoleFields = {
    timeoutMs: input.timeoutMs,
    elapsedMs,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt })
  }
  if (suspended) {
    const duration = wallFrozen ? ` for ${formatSuspendedElapsed(elapsedMs)}` : ''
    return {
      suspended: true,
      level: 'warn',
      code: 'suspended-dial',
      title: input.kind === 'connect' ? 'WebSocket connect interrupted' : 'Handshake interrupted',
      detail: `App suspended${duration}; connection state unknown, re-dialing`,
      consoleMessage: `[net] ${input.kind} deadline fired after suspension`,
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
