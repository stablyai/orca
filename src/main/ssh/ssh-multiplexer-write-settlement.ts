import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteAmbiguityReason,
  type WriteRefusalReason,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
import type { MultiplexerWriterLane } from './ssh-multiplexer-transport-writer'

export type MultiplexerWriterEntry = {
  isStillAdmitted?: () => boolean
  data: Buffer
  lane: MultiplexerWriterLane
  onSettled: (result: MultiplexerWriteSettlement) => void
  settled: boolean
}

/** All the socket itself can prove: it took the buffer, or the attempt failed. */
export type MultiplexerTransportWriteResult = { ok: true } | { ok: false; error: Error }

/**
 * A `WriteSettlement` refined with the transport error the writer needs to fail the session.
 * Only this writer knows whether an entry was still queued or already handed to the
 * transport, so it is the boundary that mints `refused` versus `unverifiable`.
 */
export type MultiplexerWriteSettlement =
  | { outcome: 'accepted' }
  | { outcome: 'refused'; reason: WriteRefusalReason; error: Error }
  | {
      outcome: 'unverifiable'
      reason: WriteAmbiguityReason
      bytesHandedToTransport: true
      error: Error
    }

export const ACCEPTED: MultiplexerWriteSettlement = { outcome: 'accepted' }

export function onceMultiplexerWriteSettlement(
  callback: (result: MultiplexerWriteSettlement) => void
): (result: MultiplexerWriteSettlement) => void {
  let settled = false
  return (result) => {
    if (settled) {
      return
    }
    settled = true
    callback(result)
  }
}

export function transportRefusal(
  reason: WriteRefusalReason,
  error: Error
): MultiplexerWriteSettlement {
  return { outcome: 'refused', reason, error }
}

/** Drops the transport error so callers carry exactly the fields `WriteSettlement` declares. */
export function toWriteSettlement(result: MultiplexerWriteSettlement): WriteSettlement {
  if (result.outcome === 'accepted') {
    return WRITE_ACCEPTED
  }
  return result.outcome === 'refused'
    ? writeRefused(result.reason)
    : writeUnverifiable(result.reason, result.bytesHandedToTransport)
}
