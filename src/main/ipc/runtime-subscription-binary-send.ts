import {
  terminalSubscriptionSendProgress,
  type TerminalSubscriptionSendProgress
} from './terminal-subscription-send-progress'

type BinarySubscription = {
  requestId: string
  environmentId: string
  method: string
  ownerWebContentsId: number
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
}

export function forwardRuntimeSubscriptionBinary(
  subscriptions: ReadonlyMap<string, BinarySubscription>,
  ownerWebContentsId: number,
  args: { subscriptionId?: unknown; bytes?: unknown },
  progress: TerminalSubscriptionSendProgress = terminalSubscriptionSendProgress
): void {
  if (typeof args.subscriptionId !== 'string') {
    return
  }
  const bytes = toBinaryPayload(args.bytes)
  if (!bytes) {
    return
  }
  const subscription = subscriptions.get(args.subscriptionId)
  if (subscription?.ownerWebContentsId === ownerWebContentsId) {
    const accepted = subscription.sendBinary(bytes)
    progress.record(
      args.subscriptionId,
      subscription,
      bytes,
      accepted ? 'accepted' : 'ipc_transport_refused'
    )
  } else {
    progress.record(
      args.subscriptionId,
      subscription,
      bytes,
      subscription ? 'ipc_owner_mismatch' : 'ipc_subscription_missing'
    )
  }
}

function toBinaryPayload(value: unknown): Uint8Array<ArrayBufferLike> | null {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}
