// Parses the E2EE handshake replies (spec S6: hello -> ready -> auth -> authenticated) into an
// event for the client to act on. Pure w.r.t. the socket — no sending, no session mutation — so
// the handshake sequencing can be reasoned about (and tested) independently of the client's
// connection/reconnect bookkeeping.
import { decryptText, deriveSharedKey, generateKeyPair, publicKeyToBase64 } from './glasses-e2ee'
import type { PendingRequestRegistry } from './orca-request-registry'
import type { SubscriptionRegistry } from './orca-subscription-registry'
import type { ConnectionStageTimer } from './orca-connection-stage-timer'
import { sendEncrypted, type WebSocketLike } from './orca-socket-frames'

// Kicks off the E2EE handshake (spec S6 step 1-2): generate an ephemeral keypair, derive the
// shared key against the server's known public key, and send e2ee_hello. Returns the derived
// shared key so the caller can store it on the session before any reply arrives.
export function beginE2eeHandshake(
  socket: { send: (data: string) => void },
  serverPublicKey: Uint8Array
): Uint8Array {
  const ephemeral = generateKeyPair()
  const sharedKey = deriveSharedKey(ephemeral.secretKey, serverPublicKey)
  const hello = { type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(ephemeral.publicKey) }
  socket.send(JSON.stringify(hello))
  return sharedKey
}

type HandshakeSession = {
  socket: WebSocketLike
  sharedKey: Uint8Array | null
  stageTimer: ConnectionStageTimer
}

// Arms the handshake-stage deadline and sends e2ee_hello for a freshly-opened socket (client's
// onopen handler) — bundles the two steps of spec S6's step 1-2 kickoff into one call.
export function startHandshakeStage(
  session: HandshakeSession,
  serverPublicKey: Uint8Array,
  timeoutMs: number,
  hooks: { onTimeout: () => void; onFailure: () => void }
): void {
  session.stageTimer.arm(timeoutMs, hooks.onTimeout)
  try {
    session.sharedKey = beginE2eeHandshake(session.socket, serverPublicKey)
  } catch {
    hooks.onFailure()
  }
}

// Reacts to a parsed handshake reply (spec S6 steps 3-7): send e2ee_auth on 'ready', or let the
// caller advance session/reconnect state on 'authenticated'/'rejected'. No-op on 'none'.
export function reactToHandshakeMessage(
  event: HandshakeEvent,
  session: { socket: WebSocketLike; sharedKey: Uint8Array | null },
  deviceToken: string,
  hooks: {
    onReady: () => void
    onAuthenticated: () => void
    onRejected: () => void
    onTransientError: () => void
  }
): void {
  switch (event.kind) {
    case 'ready':
      hooks.onReady()
      sendEncrypted(session.socket, session.sharedKey, { type: 'e2ee_auth', deviceToken })
      return
    case 'authenticated':
      hooks.onAuthenticated()
      return
    case 'rejected':
      hooks.onRejected()
      break
    case 'transientError':
      hooks.onTransientError()
      break
    case 'none':
      break
  }
}

export type HandshakeEvent =
  | { kind: 'ready' }
  | { kind: 'authenticated' }
  | { kind: 'rejected' }
  | { kind: 'transientError' }
  | { kind: 'none' }

export function parseHandshakeMessage(raw: string, sharedKey: Uint8Array | null): HandshakeEvent {
  try {
    const message = JSON.parse(raw) as { type?: unknown }
    if (message.type === 'e2ee_ready') {
      return { kind: 'ready' }
    }
    if (message.type === 'e2ee_error') {
      // Finding #9 (CWE-345): this frame is PLAINTEXT — unlike the decrypted branch below, it
      // carries no proof it came from the real host (anyone on-path can inject it before the
      // shared key is even confirmed). Treating it as an authenticated rejection would let an
      // attacker permanently latch (no-retry) a session with one forged packet. Transient only:
      // reconnect and let the real handshake run again.
      return { kind: 'transientError' }
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
  // This branch decrypted successfully with our ECDH-derived shared key — only someone holding
  // the real server's private key could have produced it, unlike the plaintext branch above.
  // That cryptographic proof of origin is what justifies latching (no retry) here.
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
