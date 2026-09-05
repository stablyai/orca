import { encryptBytes } from './e2ee'
import type { RpcClientSocketSession } from './rpc-client-socket-session'
import type { ConnectionState } from './types'

export function sendSessionEncrypted(
  session: RpcClientSocketSession | null,
  request: unknown,
  state: ConnectionState
): boolean {
  if (session) {
    return session.sendEncrypted(request)
  }
  console.log('[net] sendEncrypted FAILED — channel not ready', {
    hasWs: false,
    hasKey: false,
    state
  })
  return false
}

export function sendSocketEncryptedBinary(
  socket: WebSocket,
  key: Uint8Array | null,
  ready: boolean,
  bytes: Uint8Array,
  onFailure: () => void
): boolean {
  if (!ready || !key || socket.readyState !== WebSocket.OPEN) {
    return false
  }
  try {
    socket.send(encryptBytes(bytes, key))
    return true
  } catch {
    onFailure()
    return false
  }
}
