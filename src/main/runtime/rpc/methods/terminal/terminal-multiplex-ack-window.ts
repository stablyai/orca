import {
  TERMINAL_MULTIPLEX_ACK_BATCH_BYTES,
  TERMINAL_MULTIPLEX_PENDING_MAX_BYTES,
  TERMINAL_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES
} from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import type { TerminalMultiplexConnectionBase } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

// A probe's zero window still has one chunk in flight.
const PACED_SAMPLE_MIN_QUEUE_BYTES = 64 * 1024

type AckWindowConnection = Pick<
  TerminalMultiplexConnectionBase,
  | 'ackTotalInFlightBytes'
  | 'ackTotalWindowBytes'
  | 'ackTotalHoldbackBytes'
  | 'runtime'
  | 'linkEstimate'
>

/** Only alternate-screen output is paced: a newer frame supersedes it, so a snapshot can replace backlog. */
export function pacedAckWindowBytes(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream
): number | null {
  if (!connection.linkEstimate.enabled) {
    return null
  }
  const paced = connection.linkEstimate.pacedWindowBytes()
  return paced !== null && connection.runtime.isTerminalAlternateScreen(stream.ptyId) ? paced : null
}

/** Only then does our own window bound the queue ahead of this send, so its RTT can reveal a path change. */
export function isSentUnderPacedWindow(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream
): boolean {
  const paced = pacedAckWindowBytes(connection, stream)
  return (
    paced !== null &&
    connection.ackTotalInFlightBytes <= Math.max(paced, PACED_SAMPLE_MIN_QUEUE_BYTES)
  )
}

// Bytes pacing keeps off the wire wait here instead, so overflow recovery fires no earlier than on legacy windows.
export function ackPendingOutputBudgetBytes(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream
): number {
  if (!connection.linkEstimate.enabled) {
    return TERMINAL_MULTIPLEX_PENDING_MAX_BYTES
  }
  const paced = pacedAckWindowBytes(connection, stream)
  if (paced !== null) {
    // Legacy would have put these bytes on the wire, which the connection window also caps.
    const othersHeld = connection.ackTotalHoldbackBytes - stream.ackPendingHoldbackBytes
    const available = Math.max(
      0,
      connection.ackTotalWindowBytes - connection.ackTotalInFlightBytes - othersHeld
    )
    setAckPendingHoldback(
      connection,
      stream,
      Math.max(stream.ackPendingHoldbackBytes, Math.min(stream.ackWindowBytes - paced, available))
    )
  } else if (stream.ackPendingOutputBytes <= TERMINAL_MULTIPLEX_PENDING_MAX_BYTES) {
    // Kept until the queue drains, so leaving the alternate screen cannot force an overflow.
    setAckPendingHoldback(connection, stream, 0)
  }
  return TERMINAL_MULTIPLEX_PENDING_MAX_BYTES + stream.ackPendingHoldbackBytes
}

function setAckPendingHoldback(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream,
  bytes: number
): void {
  connection.ackTotalHoldbackBytes += bytes - stream.ackPendingHoldbackBytes
  stream.ackPendingHoldbackBytes = bytes
}

/** Pause and detach empty the queue, so its headroom returns to the connection. */
export function releaseAckPendingHoldback(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream
): void {
  if (stream.ackPendingHoldbackBytes > 0) {
    setAckPendingHoldback(connection, stream, 0)
  }
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
