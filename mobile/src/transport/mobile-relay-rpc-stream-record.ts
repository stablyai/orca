import type { RpcClient } from './rpc-client'
import type { RpcEnvelopeFields, RpcRequestFrame } from './rpc-envelope-fields'

export type StreamRecord = {
  method: string
  params: unknown
  envelope?: RpcEnvelopeFields
  listener?: (result: unknown) => unknown
  onBinaryFrame?: Parameters<RpcClient['subscribe']>[3] extends
    | { onBinaryFrame?: infer Listener }
    | undefined
    ? Listener
    : never
  streamIds: Set<number>
  subscriptionId?: string
  cancelled: boolean
  /** Position in this session's send order, or null while unsent. */
  sendOrder: number | null
  receivedSnapshot?: boolean
}

export type StreamUnsubscribe = { method: string; params: Record<string, unknown> }

// Include the whole envelope in cleanup-slot identity; sort keys so equivalent routing names the same slot.
export function unsubscribeSlot(
  { method, params }: StreamUnsubscribe,
  envelope: RpcEnvelopeFields | undefined
): string | null {
  if (!('subscriptionId' in params)) {
    return null
  }
  const client =
    'client' in params && typeof params.client === 'object' && params.client !== null
      ? params.client
      : null
  const clientId = client && 'id' in client ? client.id : null
  const routing = envelope ? Object.entries(envelope).sort(([a], [b]) => (a < b ? -1 : 1)) : null
  return JSON.stringify([method, params.subscriptionId, clientId, routing])
}
export type StreamManagerOptions = {
  nextId: () => string
  // A stream's envelope rides its subscribe and unsubscribes alike, so routing reaches one host.
  sendFrame: (frame: RpcRequestFrame) => boolean
  waitForConnected: () => Promise<void>
  sendBinary?: (bytes: Uint8Array) => boolean
}
