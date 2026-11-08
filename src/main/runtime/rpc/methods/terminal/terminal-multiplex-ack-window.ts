import {
  TERMINAL_MULTIPLEX_ACK_BATCH_BYTES,
  TERMINAL_MULTIPLEX_PENDING_MAX_BYTES,
  TERMINAL_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES
} from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import type { TerminalMultiplexConnectionBase } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

type AckWindowConnection = Pick<
  TerminalMultiplexConnectionBase,
  'ackTotalInFlightBytes' | 'ackTotalWindowBytes' | 'runtime' | 'linkEstimate'
>

/** Only alternate-screen output is paced: a newer frame supersedes it, so a snapshot can replace backlog. */
export function pacedAckWindowBytes(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream
): number | null {
  const paced = connection.linkEstimate.pacedWindowBytes()
  return paced !== null && connection.runtime.isTerminalAlternateScreen(stream.ptyId) ? paced : null
}

// Bytes pacing keeps off the wire wait here instead, so overflow recovery fires no earlier than on legacy windows.
export function ackPendingOutputBudgetBytes(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream
): number {
  const paced = pacedAckWindowBytes(connection, stream)
  return (
    TERMINAL_MULTIPLEX_PENDING_MAX_BYTES +
    (paced === null ? 0 : Math.max(0, stream.ackWindowBytes - paced))
  )
}

export function ackWindowAdmits(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream,
  bytes: number
): boolean {
  if (
    stream.ackInFlightBytes + bytes > stream.ackWindowBytes ||
    connection.ackTotalInFlightBytes + bytes > connection.ackTotalWindowBytes
  ) {
    return false
  }
  const paced = pacedAckWindowBytes(connection, stream)
  // An idle stream may always send one chunk, so a paced window under a chunk's size cannot stall.
  return paced === null || stream.ackInFlightBytes === 0 || stream.ackInFlightBytes + bytes <= paced
}

export function chargeAckWindow(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream,
  bytes: number
): void {
  stream.ackInFlightBytes += bytes
  connection.ackTotalInFlightBytes += bytes
}

/** Returns the bytes the ack actually released; windows grow by them up to their caps. */
export function creditAckWindow(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream,
  bytes: number
): number {
  const acknowledged = Math.min(stream.ackInFlightBytes, bytes)
  stream.ackWindowBytes = Math.min(
    TERMINAL_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
    stream.ackWindowBytes + acknowledged
  )
  connection.ackTotalWindowBytes = Math.min(
    TERMINAL_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES,
    connection.ackTotalWindowBytes + acknowledged
  )
  stream.ackInFlightBytes -= acknowledged
  connection.ackTotalInFlightBytes = Math.max(0, connection.ackTotalInFlightBytes - acknowledged)
  return acknowledged
}

export function releaseAckWindow(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream
): void {
  connection.ackTotalInFlightBytes = Math.max(
    0,
    connection.ackTotalInFlightBytes - stream.ackInFlightBytes
  )
  stream.ackInFlightBytes = 0
}

// Snapshots bypass ACK windows; restore history only after link drain so sustained floods cannot outrun intake.
export function ackLinkHasRoomForHistory(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream
): boolean {
  return (
    stream.ackInFlightBytes <= TERMINAL_MULTIPLEX_ACK_BATCH_BYTES &&
    connection.ackTotalInFlightBytes <= TERMINAL_MULTIPLEX_ACK_BATCH_BYTES &&
    // Paced in-flight always sits under the batch size, so only a fully drained paced stream proves room.
    (stream.ackInFlightBytes === 0 || pacedAckWindowBytes(connection, stream) === null)
  )
}
