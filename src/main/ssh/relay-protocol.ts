// ─── Relay Protocol ─────────────────────────────────────────────────
// 13-byte framing header matching VS Code's PersistentProtocol wire format.
// See design-ssh-support.md § JSON-RPC Protocol Specification.

export const RELAY_VERSION = '0.1.0'
export const RELAY_SENTINEL = `ORCA-RELAY v${RELAY_VERSION} READY\n`
export const RELAY_SENTINEL_TIMEOUT_MS = 10_000
export const RELAY_REMOTE_DIR = '.orca-remote'

// ── Framing constants (VS Code ProtocolConstants) ───────────────────

export const HEADER_LENGTH = 13
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024 // 16 MB

/** Message type byte. */
export const MessageType = {
  Regular: 1,
  KeepAlive: 9
} as const

/** Keepalive/timeout (VS Code ProtocolConstants). */
export const KEEPALIVE_SEND_MS = 5_000
export const TIMEOUT_MS = 20_000

/** PTY flow control watermarks (VS Code FlowControlConstants). */
export const PTY_FLOW_HIGH_WATERMARK = 100_000
export const PTY_FLOW_LOW_WATERMARK = 5_000

/** Reconnection grace period (default, overridable by relay --grace-time). */
export const DEFAULT_GRACE_TIME_MS = 5 * 60 * 1000 // 5 minutes

// ── Relay error codes ───────────────────────────────────────────────

export const RelayErrorCode = {
  CommandNotFound: -33001,
  PermissionDenied: -33002,
  PathNotFound: -33003,
  PtyAllocationFailed: -33004,
  DiskFull: -33005
} as const

// ── JSON-RPC types ──────────────────────────────────────────────────

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

// ── Framing: encode / decode ────────────────────────────────────────

/**
 * Encode a message into a framed buffer (13-byte header + payload).
 *
 * Header layout:
 * - [0]:    TYPE   (1 byte)
 * - [1-4]:  ID     (uint32 big-endian)
 * - [5-8]:  ACK    (uint32 big-endian)
 * - [9-12]: LENGTH (uint32 big-endian)
 */
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
    throw new Error(`Message too large: ${payload.length} bytes (max ${MAX_MESSAGE_SIZE})`)
  }
  return encodeFrame(MessageType.Regular, id, ack, payload)
}

export function encodeKeepAliveFrame(id: number, ack: number): Buffer {
  return encodeFrame(MessageType.KeepAlive, id, ack, Buffer.alloc(0))
}

export type DecodedFrame = {
  type: number
  id: number
  ack: number
  payload: Buffer
}

/**
 * Incremental frame parser. Feed it chunks of data; it emits complete frames.
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0)
  private onFrame: (frame: DecodedFrame) => void
  private onError: ((err: Error) => void) | null

  constructor(onFrame: (frame: DecodedFrame) => void, onError?: (err: Error) => void) {
    this.onFrame = onFrame
    this.onError = onError ?? null
  }

  feed(chunk: Buffer | Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, chunk])

    while (this.buffer.length >= HEADER_LENGTH) {
      const length = this.buffer.readUInt32BE(9)
      const totalLength = HEADER_LENGTH + length

      // Why: throwing here would leave the buffer in a partially consumed
      // state — subsequent feed() calls would try to parse leftover payload
      // bytes as a new header, corrupting every future frame. Instead we
      // skip the entire oversized frame so the decoder stays synchronized.
      if (length > MAX_MESSAGE_SIZE) {
        if (this.buffer.length < totalLength) {
          break
        }
        this.buffer = this.buffer.subarray(totalLength)
        const err = new Error(`Frame payload too large: ${length} bytes — discarded`)
        if (this.onError) {
          this.onError(err)
        }
        continue
      }

      if (this.buffer.length < totalLength) {
        break
      }

      const frame: DecodedFrame = {
        type: this.buffer[0],
        id: this.buffer.readUInt32BE(1),
        ack: this.buffer.readUInt32BE(5),
        payload: this.buffer.subarray(HEADER_LENGTH, totalLength)
      }

      this.buffer = this.buffer.subarray(totalLength)
      this.onFrame(frame)
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
  }
}

/**
 * Parse a JSON-RPC message from a frame payload.
 */
export function parseJsonRpcMessage(payload: Buffer): JsonRpcMessage {
  const text = payload.toString('utf-8')
  const msg = JSON.parse(text) as JsonRpcMessage
  if (msg.jsonrpc !== '2.0') {
    throw new Error(`Invalid JSON-RPC version: ${(msg as Record<string, unknown>).jsonrpc}`)
  }
  return msg
}

// ── Supported platforms ─────────────────────────────────────────────

export type RelayPlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64'

export function parseUnameToRelayPlatform(os: string, arch: string): RelayPlatform | null {
  const normalizedOs = os.toLowerCase().trim()
  const normalizedArch = arch.toLowerCase().trim()

  let relayOs: string | null = null
  if (normalizedOs === 'linux') {
    relayOs = 'linux'
  } else if (normalizedOs === 'darwin') {
    relayOs = 'darwin'
  }

  let relayArch: string | null = null
  if (normalizedArch === 'x86_64' || normalizedArch === 'amd64') {
    relayArch = 'x64'
  } else if (normalizedArch === 'aarch64' || normalizedArch === 'arm64') {
    relayArch = 'arm64'
  }

  if (!relayOs || !relayArch) {
    return null
  }
  return `${relayOs}-${relayArch}` as RelayPlatform
}
