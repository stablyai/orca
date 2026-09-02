import type { Socket } from 'node:net'
import { encodeNdjson } from './ndjson'

export type NotifySettlementRequest = {
  socket: Socket
  message: unknown
  timeoutMs: number
  // Why: a notify that never drains is the only local evidence a dead endpoint leaves.
  onUndeliverable: () => void
}

export async function writeNotifyWithSettlement(
  request: NotifySettlementRequest
): Promise<boolean> {
  const { socket, message, timeoutMs, onUndeliverable } = request
  let encoded: string
  try {
    encoded = encodeNdjson(message)
  } catch {
    return false
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (accepted: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(accepted)
    }
    const rejectAndDisconnect = (): void => {
      onUndeliverable()
      settle(false)
    }
    const timer = setTimeout(rejectAndDisconnect, timeoutMs)
    try {
      socket.write(encoded, (error) => (error ? rejectAndDisconnect() : settle(true)))
    } catch {
      rejectAndDisconnect()
    }
  })
}
