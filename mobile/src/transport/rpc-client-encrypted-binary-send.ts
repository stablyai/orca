import { encrypt, encryptBytes } from './e2ee'
import type {
  TerminalInputSendResult,
  TerminalInputStreamRegistry
} from './rpc-client-terminal-input-send'
import type { ConnectionState } from './types'

export function sendEncryptedJson(args: {
  socket: WebSocket | null
  sharedKey: Uint8Array | null
  request: unknown
  state: ConnectionState
  onWriteError: (socket: WebSocket) => void
  onDesync: (socket: WebSocket) => void
}): boolean {
  const { socket, sharedKey, request, state, onWriteError, onDesync } = args
  if (socket && socket.readyState === WebSocket.OPEN && sharedKey) {
    try {
      socket.send(encrypt(JSON.stringify(request), sharedKey))
      return true
    } catch {
      onWriteError(socket)
      return false
    }
  }
  console.log('[net] sendEncrypted FAILED — channel not ready', {
    hasWs: !!socket,
    readyState: socket?.readyState,
    hasKey: !!sharedKey,
    state
  })
  // Why: RN can drop onclose, leaving state 'connected' over a dead socket; force reconnect or every send silently fails forever.
  if (state === 'connected' && socket && socket.readyState !== WebSocket.OPEN) {
    console.log('[net] sendEncrypted detected ws desync — forcing reconnect', {
      readyState: socket.readyState
    })
    onDesync(socket)
  }
  return false
}

export function sendEncryptedBinaryPayload(args: {
  socket: WebSocket | null
  sharedKey: Uint8Array | null
  plaintext: Uint8Array
  onWriteError: (socket: WebSocket) => void
}): boolean {
  const { socket, sharedKey, plaintext, onWriteError } = args
  if (!socket || socket.readyState !== WebSocket.OPEN || !sharedKey) {
    return false
  }
  try {
    socket.send(encryptBytes(plaintext, sharedKey))
    return true
  } catch {
    onWriteError(socket)
    return false
  }
}

export function sendLanTerminalInputFrame(args: {
  registry: TerminalInputStreamRegistry
  terminal: string
  text: string
  connected: boolean
  socket: WebSocket | null
  sharedKey: Uint8Array | null
  isCurrentSocket: (socket: WebSocket) => boolean
  onWriteError: (socket: WebSocket) => void
}): TerminalInputSendResult {
  const sendingWs = args.socket
  return args.registry.send(args.terminal, args.text, args.connected, (plaintext) =>
    sendEncryptedBinaryPayload({
      socket: sendingWs,
      sharedKey: args.sharedKey,
      plaintext,
      onWriteError: (socket) => {
        if (args.isCurrentSocket(socket)) {
          args.onWriteError(socket)
        }
      }
    })
  )
}
