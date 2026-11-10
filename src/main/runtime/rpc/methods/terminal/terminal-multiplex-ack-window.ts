import {
  TERMINAL_MULTIPLEX_ACK_BATCH_BYTES,
  TERMINAL_MULTIPLEX_PENDING_MAX_BYTES,
  TERMINAL_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES
} from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import type { TerminalMultiplexConnectionBase } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'
import { PACED_WINDOW_MIN_BYTES } from './terminal-multiplex-link-estimate'

type AckWindowConnection = Pick<
  TerminalMultiplexConnectionBase,
  | 'ackTotalInFlightBytes'
  | 'ackTotalWindowBytes'
  | 'ackTotalHoldbackBytes'
  | 'runtime'
  | 'linkEstimate'
>

// Only alternate-screen output is paced: its frames supersede each other, while normal-screen output stays byte-exact.
function isPacedStream(connection: AckWindowConnection, stream: TerminalMultiplexStream): boolean {
  return (
    connection.linkEstimate.enabled && connection.runtime.isTerminalAlternateScreen(stream.ptyId)
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
  if (!connection.linkEstimate.enabled) {
    return true
  }
  // Decided once here and reused by the send, so a probe starting in between cannot mislabel the sample.
  stream.ackAdmittedPacedWindowBytes = isPacedStream(connection, stream)
    ? connection.linkEstimate.pacedWindowBytes()
    : null
  const paced = stream.ackAdmittedPacedWindowBytes
  // An idle stream may always send one chunk, so a paced window under a chunk's size cannot stall.
  return paced === null || stream.ackInFlightBytes === 0 || stream.ackInFlightBytes + bytes <= paced
}

/** Records the send for the link estimate; a paced sample is one whose queue our own window bounded. */
export function noteAckGatedSend(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream,
  bytes: number,
  backlogged: boolean
): void {
  const paced = stream.ackAdmittedPacedWindowBytes
  connection.linkEstimate.noteSent(stream, bytes, {
    backlogged,
    paced:
      paced !== null && connection.ackTotalInFlightBytes <= Math.max(paced, PACED_WINDOW_MIN_BYTES),
    connectionInFlightBytes: connection.ackTotalInFlightBytes
  })
}

// Bytes pacing keeps off the wire wait here instead, so in steady state overflow fires no earlier than on legacy windows.
export function ackPendingOutputBudgetBytes(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream
): number {
  if (!connection.linkEstimate.enabled) {
    return TERMINAL_MULTIPLEX_PENDING_MAX_BYTES
  }
  // The steady window, not a probe's zero, sizes the grant.
  const steady = isPacedStream(connection, stream)
    ? connection.linkEstimate.steadyWindowBytes()
    : null
  if (steady !== null) {
    // Legacy would have put these bytes on the wire, which the connection window also caps.
    const othersHeld = connection.ackTotalHoldbackBytes - stream.ackPendingHoldbackBytes
    const available = Math.max(
      0,
      connection.ackTotalWindowBytes - connection.ackTotalInFlightBytes - othersHeld
    )
    setAckPendingHoldback(
      connection,
      stream,
      Math.max(
        stream.ackPendingHoldbackBytes,
        Math.min(Math.max(0, stream.ackWindowBytes - steady), available)
      )
    )
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

/** Once the queue is back within the legacy cap (drained, paused or detached), its headroom returns to the connection. */
export function releaseAckPendingHoldbackIfDrained(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream
): void {
  if (
    stream.ackPendingHoldbackBytes > 0 &&
    stream.ackPendingOutputBytes <= TERMINAL_MULTIPLEX_PENDING_MAX_BYTES
  ) {
    setAckPendingHoldback(connection, stream, 0)
  }
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
  stream.ackRecoveryAwaitedBytes = Math.max(0, stream.ackRecoveryAwaitedBytes - acknowledged)
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
  stream.ackRecoveryAwaitedBytes = 0
}

// Snapshots bypass ACK windows; restore history only after link drain so sustained floods cannot outrun intake.
export function ackLinkHasRoomForHistory(
  connection: AckWindowConnection,
  stream: TerminalMultiplexStream
): boolean {
  return (
    stream.ackInFlightBytes <= TERMINAL_MULTIPLEX_ACK_BATCH_BYTES &&
    connection.ackTotalInFlightBytes <= TERMINAL_MULTIPLEX_ACK_BATCH_BYTES &&
    // Paced in-flight is small by design, so only a fully drained paced stream proves the link has room.
    (stream.ackInFlightBytes === 0 ||
      !isPacedStream(connection, stream) ||
      connection.linkEstimate.steadyWindowBytes() === null)
  )
}
