import {
  MAX_PROVIDER_RECEIPT_REPLY_BYTES,
  MAX_PROVIDER_RECEIPT_REPLY_KEYS,
  type ProviderReceiptReply,
  type ProviderReceiptStreamUpdate,
  type ProviderReceiptUpdate
} from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'

function providerReceiptEnvelope(runtimeId: string, reply: ProviderReceiptReply) {
  return { id: 'desktop-ipc', ok: true as const, result: reply, _meta: { runtimeId } }
}

const encoder = new TextEncoder()

export function encodeProviderReceiptFrame(
  runtimeId: string,
  reply: ProviderReceiptReply
): Uint8Array {
  return encoder.encode(JSON.stringify(providerReceiptEnvelope(runtimeId, reply)))
}

function emptyProviderReceiptFrameBytes(runtimeId: string, reply: ProviderReceiptReply): number {
  return Buffer.byteLength(JSON.stringify(providerReceiptEnvelope(runtimeId, reply)))
}

export function fitProviderReceiptUpdates(
  runtimeId: string,
  reply: ProviderReceiptReply,
  frame: ProviderReceiptStreamUpdate,
  updates: readonly ProviderReceiptUpdate[]
): boolean {
  // Zero or one update fits as a whole, or falls back to the capacity reply.
  if (updates.length <= 1) {
    frame.updates.push(...updates)
    if (frame.reset) {
      frame.reset.complete = true
    }
    return true
  }
  let bytes = emptyProviderReceiptFrameBytes(runtimeId, reply)
  for (const update of updates) {
    const appended = Buffer.byteLength(JSON.stringify(update)) + (frame.updates.length ? 1 : 0)
    if (
      bytes + appended > MAX_PROVIDER_RECEIPT_REPLY_BYTES ||
      frame.updates.length === MAX_PROVIDER_RECEIPT_REPLY_KEYS
    ) {
      break
    }
    frame.updates.push(update)
    bytes += appended
  }
  const complete = frame.updates.length === updates.length
  if (frame.reset) {
    frame.reset.complete = complete
  }
  return complete
}
