import { HEADER_LENGTH, MAX_MESSAGE_SIZE } from '../../../shared/relay-frame-decoder'

export const MessageType = {
  Regular: 1,
  KeepAlive: 9
} as const

export const KEEPALIVE_SEND_MS = 5_000

export const TIMEOUT_MS = 20_000

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

const JSON_RPC_PAYLOAD_BYTES = Symbol('jsonRpcPayloadBytes')

export type PreparedJsonRpcPayload = Readonly<{
  byteLength: number
  [JSON_RPC_PAYLOAD_BYTES]: Buffer
}>

/** Match PersistentProtocol: type byte, then big-endian uint32 id/ack/length at offsets 1/5/9, then payload. */
export function encodeFrame(
  type: number,
  id: number,
  ack: number,
  payload: Buffer | Uint8Array
): Buffer {
  const header = Buffer.alloc(HEADER_LENGTH)
  header[0] = type
  header.writeUInt32BE(id, 1)
  header.writeUInt32BE(ack, 5)
  header.writeUInt32BE(payload.length, 9)
  return Buffer.concat([header, payload])
}

export function encodeJsonRpcFrame(msg: JsonRpcMessage, id: number, ack: number): Buffer {
  return encodePreparedJsonRpcFrame(prepareJsonRpcPayload(msg), id, ack)
}

export function prepareJsonRpcPayload(msg: JsonRpcMessage): PreparedJsonRpcPayload {
  const payload = Buffer.from(JSON.stringify(msg), 'utf-8')
  if (payload.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Message too large: ${payload.length} bytes (max ${MAX_MESSAGE_SIZE})`)
  }
  return Object.freeze({ byteLength: payload.length, [JSON_RPC_PAYLOAD_BYTES]: payload })
}

export function encodePreparedJsonRpcFrame(
  payload: PreparedJsonRpcPayload,
  id: number,
  ack: number
): Buffer {
  return encodeFrame(MessageType.Regular, id, ack, payload[JSON_RPC_PAYLOAD_BYTES])
}

export function encodeKeepAliveFrame(id: number, ack: number): Buffer {
  return encodeFrame(MessageType.KeepAlive, id, ack, Buffer.alloc(0))
}

export function parseJsonRpcMessage(payload: Buffer): JsonRpcMessage {
  const text = payload.toString('utf-8')
  const msg = JSON.parse(text) as JsonRpcMessage
  if (msg.jsonrpc !== '2.0') {
    throw new Error(`Invalid JSON-RPC version: ${String((msg as Record<string, unknown>).jsonrpc)}`)
  }
  return msg
}
