import { Duplex } from 'node:stream'
import { BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES } from './browser-network-tunnel-stream-state'

type BrowserNetworkTunnelDuplexOptions = {
  writeBytes: (bytes: Uint8Array<ArrayBufferLike>, callback: (error?: Error | null) => void) => void
  requestRead: () => void
  consumeReadBytes: (bytes: number) => void
  finishWrite: (callback: (error?: Error | null) => void) => void
  destroyStream: (error: Error | null, callback: (error?: Error | null) => void) => void
}

export class BrowserNetworkTunnelDuplex extends Duplex {
  private readonly options: BrowserNetworkTunnelDuplexOptions

  constructor(options: BrowserNetworkTunnelDuplexOptions) {
    super({
      allowHalfOpen: true,
      readableHighWaterMark: BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
    })
    // Why: retirement destroys with an error before any consumer holds the duplex
    // (pre-open failures, opened-frame races), and an unobserved 'error' crashes the process.
    this.on('error', () => {})
    this.options = options
  }

  override _read(): void {
    this.options.requestRead()
  }

  settleRead(bytes: number): void {
    this.options.consumeReadBytes(bytes)
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.options.writeBytes(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.options.finishWrite(callback)
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.options.destroyStream(error, callback)
  }
}
