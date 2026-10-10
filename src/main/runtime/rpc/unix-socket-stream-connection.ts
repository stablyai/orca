// Why: one upgraded local socket carries JSON RPC and binary terminal frames, like an authenticated
// WebSocket, but with no encryption — the 0o600 socket inside the private userData dir already limits
// it to this user, and the upgrade itself required the owner token.
import type { Socket } from 'node:net'
import {
  RUNTIME_LOCAL_STREAM_MAX_INBOUND_FRAME_BYTES,
  RUNTIME_LOCAL_STREAM_MAX_OUTBOUND_FRAME_BYTES,
  RuntimeLocalStreamFrameKind,
  createRuntimeLocalStreamFrameReader,
  encodeRuntimeLocalStreamFrame
} from '../../../shared/runtime-local-stream-protocol'

// Why: same per-socket ceiling as the encrypted mobile channel; a stalled reader must not grow main's heap.
export const UNIX_SOCKET_STREAM_MAX_BUFFERED_BYTES = 32 * 1024 * 1024

export type UnixSocketStreamConnectionHandlers = {
  onText: (text: string) => void
  onBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
  onClose: () => void
}

export class UnixSocketStreamConnection {
  private handlers: UnixSocketStreamConnectionHandlers | null = null
  private pendingInbound: Buffer[] = []
  private closed = false
  private readonly reader = createRuntimeLocalStreamFrameReader(
    {
      onText: (text) => this.handlers?.onText(text),
      onBinary: (bytes) => this.handlers?.onBinary(bytes),
      onFatal: () => this.close()
    },
    RUNTIME_LOCAL_STREAM_MAX_INBOUND_FRAME_BYTES
  )

  constructor(
    private readonly socket: Socket,
    private readonly maxBufferedBytes = UNIX_SOCKET_STREAM_MAX_BUFFERED_BYTES
  ) {
    socket.once('close', () => {
      this.closed = true
      this.pendingInbound = []
      this.handlers?.onClose()
    })
  }

  get isOpen(): boolean {
    return !this.closed && !this.socket.destroyed && this.socket.writable
  }

  // Why: frames that arrived with the upgrade line wait here until the dispatcher has bound its handlers.
  bind(handlers: UnixSocketStreamConnectionHandlers): void {
    this.handlers = handlers
    if (this.closed) {
      handlers.onClose()
      return
    }
    const pending = this.pendingInbound
    this.pendingInbound = []
    for (const chunk of pending) {
      this.reader.feed(chunk)
    }
  }

  feed(chunk: Buffer): void {
    if (this.closed) {
      return
    }
    if (!this.handlers) {
      this.pendingInbound.push(chunk)
      return
    }
    this.reader.feed(chunk)
  }

  sendText(text: string): void {
    if (!this.isOpen) {
      return
    }
    if (this.socket.writableLength > this.maxBufferedBytes) {
      // Why: a reply cannot be dropped silently; closing lets the client resync from fresh requests.
      this.close()
      return
    }
    this.socket.write(encodeRuntimeLocalStreamFrame(RuntimeLocalStreamFrameKind.Text, text))
  }

  // Why: false means "discarded" to terminal multiplexing, which then closes and resnapshots; kernel
  // backpressure alone is not a discard, so frames queue until the buffered ceiling.
  sendBinary(bytes: Uint8Array<ArrayBufferLike>): boolean {
    if (!this.isOpen || bytes.length > RUNTIME_LOCAL_STREAM_MAX_OUTBOUND_FRAME_BYTES) {
      return false
    }
    if (this.socket.writableLength + bytes.length > this.maxBufferedBytes) {
      return false
    }
    this.socket.write(encodeRuntimeLocalStreamFrame(RuntimeLocalStreamFrameKind.Binary, bytes))
    return true
  }

  close(): void {
    if (!this.socket.destroyed) {
      this.socket.destroy()
    }
  }
}
