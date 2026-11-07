// Duck-typed WebSocket for MobileSocketWiring / E2EEChannel over an iroh bi-stream.
import { EventEmitter } from 'node:events'
import type { BiStream, Connection } from '@number0/iroh'
import {
  encodeIrohFramePayload,
  encodeLengthPrefixedFrame,
  IROH_MAX_FRAME_BYTES
} from './iroh-frame-codec'

const WRITE_CHUNK_BYTES = 64 * 1024

export class IrohFramedSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = this.OPEN
  bufferedAmount = 0
  private writeChain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly bi: BiStream,
    private readonly connection: Connection
  ) {
    super()
  }

  /** Queue complete frames in order; oversize payloads or write failures close the socket. */
  send(data: string | Buffer | Uint8Array, options?: { binary?: boolean }): void {
    if (this.readyState !== this.OPEN) {
      return
    }
    const payload = encodeIrohFramePayload(data, options?.binary)
    if (payload.byteLength > IROH_MAX_FRAME_BYTES) {
      this.terminate()
      return
    }
    const frame = encodeLengthPrefixedFrame(payload)
    this.bufferedAmount += frame.byteLength
    this.writeChain = this.writeChain
      .then(async () => {
        if (this.closed) {
          return
        }
        await this.writeAllChunked(frame)
        this.bufferedAmount = Math.max(0, this.bufferedAmount - frame.byteLength)
      })
      .catch((error: unknown) => {
        this.bufferedAmount = 0
        this.emit('error', error instanceof Error ? error : new Error(String(error)))
        this.terminate()
      })
  }

  /** Report completed native chunks, never queued writes or completions after shutdown. */
  private async writeAllChunked(bytes: Buffer): Promise<void> {
    let offset = 0
    while (offset < bytes.byteLength && !this.closed) {
      const end = Math.min(offset + WRITE_CHUNK_BYTES, bytes.byteLength)
      await this.bi.send.writeAll(Array.from(bytes.subarray(offset, end)))
      if (this.closed) {
        return
      }
      this.emit('write-progress')
      offset = end
    }
  }

  close(code?: number, reason?: string): void {
    this.shutdown(code, reason)
  }

  terminate(): void {
    this.shutdown()
  }

  // Why: WS heartbeat pings are a no-op; idle reaper covers half-open peers.
  ping(): void {}

  /** Close once, forwarding authentication close codes and reasons to the QUIC peer. */
  private shutdown(code?: number, reason?: string): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.readyState = this.CLOSED
    try {
      // Why: carry the WS close code (e.g. 4001 auth) into the QUIC close so
      // the phone can distinguish auth rejection from a transient drop.
      this.connection.close(BigInt(code ?? 0), Array.from(Buffer.from(reason ?? '', 'utf8')))
    } catch {
      // Already closed.
    }
    this.emit('close')
  }
}

export { WRITE_CHUNK_BYTES }
