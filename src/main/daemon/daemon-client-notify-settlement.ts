import type { Socket } from 'node:net'
import { encodeNdjson } from './ndjson'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'

export type NotifySettlementRequest = {
  socket: Socket | null
  message: unknown
  timeoutMs: number
  // Why: a notify that never drains is the only local evidence a dead endpoint leaves.
  onUndeliverable: () => void
}

/** Ambiguity is returned, not thrown: a stalled socket cannot prove the bytes never left. */
export async function writeNotifyWithSettlement(
  request: NotifySettlementRequest
): Promise<WriteSettlement> {
  const { socket, message, timeoutMs, onUndeliverable } = request
  if (!socket) {
    return writeRefused('endpoint_disconnected')
  }
  let encoded: string
  try {
    encoded = encodeNdjson(message)
  } catch {
    return writeRefused('encode_failed')
  }
  return await new Promise<WriteSettlement>((resolve) => {
    let settled = false
    const settle = (settlement: WriteSettlement): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(settlement)
    }
    const disconnectAndSettle = (settlement: WriteSettlement): void => {
      if (settled) {
        return
      }
      settle(settlement)
      try {
        onUndeliverable()
      } catch (error) {
        console.warn('[daemon] Write recovery notification failed:', error)
      }
    }
    const timer = setTimeout(
      () => disconnectAndSettle(writeUnverifiable('settlement_timeout', true)),
      timeoutMs
    )
    try {
      socket.write(encoded, (error) =>
        error
          ? disconnectAndSettle(writeUnverifiable('transport_settlement_lost', true))
          : settle(WRITE_ACCEPTED)
      )
    } catch {
      // A synchronous throw can follow a partial flush.
      disconnectAndSettle(writeUnverifiable('endpoint_write_threw', true))
    }
  })
}

export function writeDaemonNotify(socket: Socket, message: unknown): boolean {
  try {
    socket.write(encodeNdjson(message))
    return true
  } catch {
    // Notifications are best-effort; an oversized payload must not tear down the caller.
    return false
  }
}
