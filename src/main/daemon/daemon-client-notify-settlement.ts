import { reportWriteSettlement, type WriteSettlementSink } from '../../shared/chat-stop-input'
import type { Socket } from 'node:net'
import { encodeNdjson } from './ndjson'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'

export const NOTIFY_SETTLEMENT_TIMEOUT_MS = 5000

export type NotifySettlementRequest = {
  socket: Socket
  message: unknown
  timeoutMs: number
  // Failure to drain provides a local signal for dead-endpoint recovery.
  onUndeliverable: () => void
}

/** Ambiguity is returned, not thrown: a stalled socket cannot prove the bytes never left. */
export function writeNotify(
  request: NotifySettlementRequest,
  onSettlement?: WriteSettlementSink
): boolean {
  const { socket, message, timeoutMs, onUndeliverable } = request
  let encoded: string
  try {
    encoded = encodeNdjson(message)
  } catch {
    reportWriteSettlement(onSettlement, writeRefused('encode_failed'))
    return false
  }

  if (!onSettlement) {
    try {
      socket.write(encoded)
      return true
    } catch {
      return false
    }
  }

  let settled = false
  const settle = (settlement: WriteSettlement): void => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    reportWriteSettlement(onSettlement, settlement)
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
    return true
  } catch {
    // A synchronous throw can follow a partial flush.
    disconnectAndSettle(writeUnverifiable('endpoint_write_threw', true))
    return false
  }
}

export function writeNotifyWithSettlement(
  request: NotifySettlementRequest
): Promise<WriteSettlement> {
  return new Promise((resolve) => {
    writeNotify(request, resolve)
  })
}

export function notifyDaemonSocket(
  socket: Socket,
  message: unknown,
  onSettlement?: WriteSettlementSink
): boolean {
  return writeNotify(
    { socket, message, timeoutMs: NOTIFY_SETTLEMENT_TIMEOUT_MS, onUndeliverable: () => {} },
    onSettlement
  )
}
