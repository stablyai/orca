import {
  TERMINAL_MULTIPLEX_ACK_BATCH_BYTES,
  TERMINAL_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES
} from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import type { TerminalMultiplexConnectionBase } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

type AckWindowConnection = Pick<
  TerminalMultiplexConnectionBase,
  'ackTotalInFlightBytes' | 'ackTotalWindowBytes'
>

export function ackWindowAdmits(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream,
  bytes: number
): boolean {
  return (
    stream.ackInFlightBytes + bytes <= stream.ackWindowBytes &&
    connection.ackTotalInFlightBytes + bytes <= connection.ackTotalWindowBytes
  )
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
    connection.ackTotalInFlightBytes <= TERMINAL_MULTIPLEX_ACK_BATCH_BYTES
  )
}
