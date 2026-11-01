// Unit 6: e2ee_hello / e2ee_auth handshake handlers for MockOrcaServer, split out of
// mock-orca-server.ts to keep that file under the line ceiling. Wire shapes mirror
// mobile/src/transport/e2ee.ts exactly (spec S6).
import nacl from 'tweetnacl'
import { base64ToBytes, decryptText } from './mock-orca-server-encryption'
import type { MemorySocketLike } from './memory-socket-pair'
import type { ConnectionState } from './mock-orca-connection-state'

export type HandshakeContext = {
  getServerSecretKey(): Uint8Array
  getDeviceToken(): string
  /** Reads and clears the one-shot rejectAuth() arm. */
  consumeRejectNextAuth(): boolean
  registerConnection(socket: MemorySocketLike, state: ConnectionState): void
  sendEncryptedText(socket: MemorySocketLike, state: ConnectionState, message: unknown): void
}

export function handleHello(
  ctx: HandshakeContext,
  socket: MemorySocketLike,
  data: string | ArrayBuffer
): void {
  if (typeof data !== 'string') {
    socket.close(1002, 'expected e2ee_hello')
    return
  }
  let hello: { type?: string; publicKeyB64?: string }
  try {
    hello = JSON.parse(data)
  } catch {
    socket.send(JSON.stringify({ type: 'e2ee_error', message: 'Invalid JSON' }))
    socket.close()
    return
  }
  if (hello.type !== 'e2ee_hello' || typeof hello.publicKeyB64 !== 'string') {
    socket.send(JSON.stringify({ type: 'e2ee_error', message: 'Expected e2ee_hello' }))
    socket.close()
    return
  }
  const clientPublicKey = base64ToBytes(hello.publicKeyB64)
  if (clientPublicKey.length !== 32) {
    socket.send(JSON.stringify({ type: 'e2ee_error', message: 'Invalid public key' }))
    socket.close()
    return
  }
  const sharedKey = nacl.box.before(clientPublicKey, ctx.getServerSecretKey())
  ctx.registerConnection(socket, {
    sharedKey,
    authenticated: false,
    notificationSubscriptionId: null,
    terminalSubscriptions: new Map()
  })
  socket.send(JSON.stringify({ type: 'e2ee_ready' }))
}

export function handleAuth(
  ctx: HandshakeContext,
  socket: MemorySocketLike,
  state: ConnectionState,
  data: string
): void {
  const plaintext = decryptText(data, state.sharedKey)
  if (plaintext === null) {
    return
  }
  let auth: { type?: string; deviceToken?: string }
  try {
    auth = JSON.parse(plaintext)
  } catch {
    return
  }
  const rejectThisAuth = ctx.consumeRejectNextAuth()
  if (rejectThisAuth || auth.type !== 'e2ee_auth' || auth.deviceToken !== ctx.getDeviceToken()) {
    ctx.sendEncryptedText(socket, state, { type: 'e2ee_error', error: { code: 'unauthorized' } })
    socket.close()
    return
  }
  state.authenticated = true
  ctx.sendEncryptedText(socket, state, { type: 'e2ee_authenticated' })
}
