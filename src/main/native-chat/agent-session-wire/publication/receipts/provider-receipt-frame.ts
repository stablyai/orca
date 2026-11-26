import {
  MAX_PROVIDER_RECEIPT_REPLY_BYTES,
  MAX_PROVIDER_RECEIPT_REPLY_KEYS,
  type ProviderReceiptReply,
  type ProviderReceiptStreamUpdate,
  type ProviderReceiptUpdate
} from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'

export function providerReceiptEnvelope(runtimeId: string, reply: ProviderReceiptReply) {
  return { id: 'desktop-ipc', ok: true as const, result: reply, _meta: { runtimeId } }
}

export function providerReceiptFrameBytes(runtimeId: string, reply: ProviderReceiptReply): number {
  return Buffer.byteLength(JSON.stringify(providerReceiptEnvelope(runtimeId, reply)))
}

export function fitProviderReceiptUpdates(
  bytes: number,
  frame: ProviderReceiptStreamUpdate,
  updates: readonly ProviderReceiptUpdate[]
): boolean {
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
