// Parses the E2EE handshake replies (spec S6: hello -> ready -> auth -> authenticated) into an
// event for the client to act on. Pure w.r.t. the socket — no sending, no session mutation — so
// the handshake sequencing can be reasoned about (and tested) independently of the client's
// connection/reconnect bookkeeping.
import { decryptText } from './glasses-e2ee'
import type { PendingRequestRegistry } from './orca-request-registry'
import type { SubscriptionRegistry } from './orca-subscription-registry'

export type HandshakeEvent =
  | { kind: 'ready' }
  | { kind: 'authenticated' }
  | { kind: 'rejected' }
  | { kind: 'none' }

export function parseHandshakeMessage(raw: string, sharedKey: Uint8Array | null): HandshakeEvent {
  try {
    const message = JSON.parse(raw) as { type?: unknown }
    if (message.type === 'e2ee_ready') {
      return { kind: 'ready' }
    }
    if (message.type === 'e2ee_error') {
      // Why: a plaintext rejection at the hello stage (spec S6 step 3) is treated the same as
      // an authenticated `unauthorized` — no retry storm against a pairing the host refuses.
      return { kind: 'rejected' }
    }
  } catch {
    // Not plaintext JSON — assume it's the encrypted e2ee_authenticated/e2ee_error reply.
  }
  if (!sharedKey) {
    return { kind: 'none' }
  }
  const plaintext = decryptText(raw, sharedKey)
  if (plaintext === null) {
    return { kind: 'none' }
  }
  let message: { type?: unknown; ok?: unknown; error?: { code?: unknown } }
  try {
    message = JSON.parse(plaintext)
  } catch {
    return { kind: 'none' }
  }
  if (message.type === 'e2ee_authenticated') {
    return { kind: 'authenticated' }
  }
  if (
    message.type === 'e2ee_error' ||
    (message.ok === false && message.error?.code === 'unauthorized')
  ) {
    return { kind: 'rejected' }
  }
  return { kind: 'none' }
}

// Runs the post-e2ee_authenticated bootstrap (spec S6 steps 8-10): advertise capabilities (the
// result is discarded — only that the frame reached the wire matters), then replay whatever
// requests/subscriptions were queued while the session was unauthenticated.
export function runAuthenticatedBootstrap(
  deviceToken: string,
  nextId: () => string,
  pending: PendingRequestRegistry,
  subscriptions: SubscriptionRegistry,
  send: (payload: unknown) => boolean
): void {
  send({
    id: nextId(),
    deviceToken,
    method: 'runtime.clientCapabilities.update',
    params: { clientCapabilities: [] }
  })
  for (const request of pending.values()) {
    send({ id: request.id, deviceToken, method: request.method, params: request.params })
  }
  for (const subscription of subscriptions.values()) {
    if (subscription.cancelled) {
      continue
    }
    send({
      id: subscription.id,
      deviceToken,
      method: subscription.method,
      params: subscription.params
    })
  }
}
