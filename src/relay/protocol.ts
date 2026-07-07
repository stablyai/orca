// Self-contained relay protocol — mirrors src/main/ssh/relay-protocol.ts
// but has no Electron dependencies. Deployed standalone to remote hosts.

export const RELAY_VERSION = '0.1.0'
export const RELAY_SENTINEL = `ORCA-RELAY v${RELAY_VERSION} READY\n`

export const HEADER_LENGTH = 13
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024

export const MessageType = {
  Regular: 1,
  Handshake: 2,
  KeepAlive: 9
} as const

// Why: a pre-dispatcher envelope on a freshly-accepted Unix socket. The daemon
// reads exactly one Handshake frame before attaching the JSON-RPC dispatcher,
// to refuse mismatched-version --connect bridges that would otherwise drive a
// stale daemon.
export type HandshakeMessage =
  | { type: 'orca-relay-handshake'; version: string }
  | { type: 'orca-relay-handshake-ok'; version: string }
  | { type: 'orca-relay-handshake-mismatch'; expected: string; got: string }

export function encodeHandshakeFrame(msg: HandshakeMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(msg), 'utf-8')
  return encodeFrame(MessageType.Handshake, 0, 0, payload)
}

export function parseHandshakeMessage(payload: Buffer): HandshakeMessage {
  const msg = JSON.parse(payload.toString('utf-8')) as HandshakeMessage
  const t = (msg as { type?: string }).type
  if (
    t !== 'orca-relay-handshake' &&
    t !== 'orca-relay-handshake-ok' &&
    t !== 'orca-relay-handshake-mismatch'
  ) {
    throw new Error(`Unknown handshake type: ${t}`)
  }
  return msg
}

export const KEEPALIVE_SEND_MS = 5_000
export const TIMEOUT_MS = 20_000

// ── Streaming constants (see docs/relay-file-stream-design.md) ─────

export const STREAM_CHUNK_SIZE = 256 * 1024
export const MAX_CONCURRENT_STREAMS = 16

/** Max unacked fs.streamChunk frames in flight per stream when the client
 * requested `flowControl: 'ack'`. Bounds how many bulk bytes an interactive
 * pty.data frame can queue behind on the shared SSH channel (~1MB raw) while
 * keeping the pipe full across one ack round-trip on fast links. */
export const STREAM_ACK_WINDOW_CHUNKS = 4

/** Safety-valve poll interval for a pump stalled on acks: re-checks stream
 * abort/staleness so a client that vanished mid-stream cannot park the pump
 * (and its open file handle) forever. */
export const STREAM_ACK_STALL_RECHECK_MS = 1_000

export const RelayErrorCode = {
  TooManyStreams: -33006,
  StreamProtocolError: -33007
} as const

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

export type DecodedFrame = {
  type: number
  id: number
  ack: number
  payload: Buffer
}

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
  const payload = Buffer.from(JSON.stringify(msg), 'utf-8')
  if (payload.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Message too large: ${payload.length} bytes`)
  }
  return encodeFrame(MessageType.Regular, id, ack, payload)
}

export function encodeKeepAliveFrame(id: number, ack: number): Buffer {
  return encodeFrame(MessageType.KeepAlive, id, ack, Buffer.alloc(0))
}

export class FrameDecoder {
  // Why: feed() sits on the hot receive path. Rebuilding one contiguous
  // buffer per feed (Buffer.concat) re-copies every already-buffered byte for
  // each incoming chunk — O(n²) per large frame. A chunk list assembles each
  // frame exactly once instead.
  private chunks: Buffer[] = []
  private bufferedLength = 0
  private onFrame: (frame: DecodedFrame) => void
  private onError: ((err: Error) => void) | null

  constructor(onFrame: (frame: DecodedFrame) => void, onError?: (err: Error) => void) {
    this.onFrame = onFrame
    this.onError = onError ?? null
  }

  feed(chunk: Buffer | Uint8Array): void {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (buf.length > 0) {
      this.chunks.push(buf)
      this.bufferedLength += buf.length
    }

    while (this.bufferedLength >= HEADER_LENGTH) {
      const header = this.peekBytes(HEADER_LENGTH)
      const length = header.readUInt32BE(9)
      const totalLength = HEADER_LENGTH + length

      if (this.bufferedLength < totalLength) {
        // Not fully received yet (also holds oversized frames until they can
        // be skipped whole, keeping the decoder synchronized).
        break
      }

      if (length > MAX_MESSAGE_SIZE) {
        // Why: Throwing here would leave the buffer in a partially consumed
        // state — subsequent feed() calls would try to parse the leftover
        // payload bytes as a new header, corrupting every future frame.
        // Instead we skip the entire oversized frame so the decoder stays
        // synchronized with the stream.
        this.discardBytes(totalLength)
        const err = new Error(`Frame payload too large: ${length} bytes — discarded`)
        if (this.onError) {
          this.onError(err)
        } else {
          process.stderr.write(`[relay] ${err.message}\n`)
        }
        continue
      }

      const framed = this.takeBytes(totalLength)
      const frame: DecodedFrame = {
        type: framed[0],
        id: framed.readUInt32BE(1),
        ack: framed.readUInt32BE(5),
        payload: framed.subarray(HEADER_LENGTH, totalLength)
      }
      this.onFrame(frame)
    }
  }

  reset(): void {
    this.chunks = []
    this.bufferedLength = 0
  }

  // Why: at the handshake → dispatcher transition, the next consumer must
  // pick up any bytes that arrived in the same TCP chunk as the handshake
  // frame. This returns and clears the decoder's internal residue so the
  // caller can hand it to the dispatcher (or stdout pipe) without loss.
  drain(): Buffer {
    const out =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.bufferedLength)
    this.reset()
    return out
  }

  /** View of the first `count` buffered bytes without consuming them. */
  private peekBytes(count: number): Buffer {
    const first = this.chunks[0]
    if (first.length >= count) {
      return first
    }
    const out = Buffer.allocUnsafe(count)
    let copied = 0
    for (const part of this.chunks) {
      copied += part.copy(out, copied, 0, Math.min(part.length, count - copied))
      if (copied >= count) {
        break
      }
    }
    return out
  }

  /** Consume and return the first `count` buffered bytes (single copy). */
  private takeBytes(count: number): Buffer {
    const first = this.chunks[0]
    if (first.length === count) {
      this.chunks.shift()
      this.bufferedLength -= count
      return first
    }
    if (first.length > count) {
      this.chunks[0] = first.subarray(count)
      this.bufferedLength -= count
      return first.subarray(0, count)
    }
    const out = Buffer.allocUnsafe(count)
    let copied = 0
    while (copied < count) {
      const part = this.chunks[0]
      const take = Math.min(part.length, count - copied)
      part.copy(out, copied, 0, take)
      copied += take
      if (take === part.length) {
        this.chunks.shift()
      } else {
        this.chunks[0] = part.subarray(take)
      }
    }
    this.bufferedLength -= count
    return out
  }

  /** Consume the first `count` buffered bytes without assembling them. */
  private discardBytes(count: number): void {
    let remaining = count
    while (remaining > 0) {
      const part = this.chunks[0]
      if (part.length <= remaining) {
        this.chunks.shift()
        remaining -= part.length
      } else {
        this.chunks[0] = part.subarray(remaining)
        remaining = 0
      }
    }
    this.bufferedLength -= count
  }
}

export function parseJsonRpcMessage(payload: Buffer): JsonRpcMessage {
  const text = payload.toString('utf-8')
  const msg = JSON.parse(text) as JsonRpcMessage
  if (msg.jsonrpc !== '2.0') {
    throw new Error(`Invalid JSON-RPC version: ${(msg as Record<string, unknown>).jsonrpc}`)
  }
  return msg
}
