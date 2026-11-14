import type { Socket } from 'node:net'
import { encodeNdjson } from '../../../../shared/main-process-ndjson-framer'
import { startResponsiveDeadline } from './daemon-responsive-deadline'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

export type NotifySettlementRequest = {
  socket: Socket
  message: unknown
  timeoutMs: number
  // Failure to drain provides a local signal for dead-endpoint recovery.
  onUndeliverable: () => void
}

/** Ambiguity is returned, not thrown: a stalled socket cannot prove the bytes never left. */
export async function writeNotifyWithSettlement(
  request: NotifySettlementRequest
): Promise<WriteSettlement> {
  const { socket, message, timeoutMs, onUndeliverable } = request
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
      cancelDeadline()
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
    // A freeze in this process must not read as a dead endpoint and tear down every session's link.
    const cancelDeadline = startResponsiveDeadline(timeoutMs, () =>
      disconnectAndSettle(writeUnverifiable('settlement_timeout', true))
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
