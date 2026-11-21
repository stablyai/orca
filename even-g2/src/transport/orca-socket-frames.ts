// Frame helpers: the WebSocket abstraction, wire-shape guards, and (de)serialization of
// authenticated frames shared by the client's message handling. Kept free of OrcaSocketClient's
// own session/reconnect state.
import { decryptBytes, decryptText, encryptText } from './glasses-e2ee'
import type { RpcResponse } from './orca-rpc-wire'
import { decodeTerminalStreamFrame } from '@orca-shared/terminal-stream-protocol'

// Structural subset of the DOM WebSocket the client actually touches, so tests can inject an
// in-memory fake without satisfying the full lib.dom WebSocket type.
export type WebSocketLike = {
  send(data: string | ArrayBufferLike | ArrayBufferView): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  binaryType?: string
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as { id?: unknown; ok?: unknown }
  return typeof candidate.id === 'string' && typeof candidate.ok === 'boolean'
}

export function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  return null
}

export function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike
}

// Best-effort encrypted send: false just means the frame never reached the wire (closed/failed
// socket) — callers already tolerate that via reconnect/retry, so no throw here.
export function sendEncrypted(
  socket: WebSocketLike,
  sharedKey: Uint8Array | null,
  payload: unknown
): boolean {
  if (!sharedKey) {
    return false
  }
  try {
    socket.send(encryptText(JSON.stringify(payload), sharedKey))
    return true
  } catch {
    return false
  }
}

export function decodeAuthenticatedRpcResponse(
  raw: string,
  sharedKey: Uint8Array
): RpcResponse | null {
  const plaintext = decryptText(raw, sharedKey)
  if (plaintext === null) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return null
  }
  return isRpcResponse(parsed) ? parsed : null
}

export function decodeAuthenticatedBinaryFrame(
  bytes: Uint8Array,
  sharedKey: Uint8Array
): { streamId: number; plaintext: Uint8Array } | null {
  const plaintext = decryptBytes(bytes, sharedKey)
  if (!plaintext) {
    return null
  }
  const frame = decodeTerminalStreamFrame(plaintext)
  return frame ? { streamId: frame.streamId, plaintext } : null
}
