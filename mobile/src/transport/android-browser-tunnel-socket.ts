import type {
  BrowserNetworkTunnelClientSocket,
  BrowserNetworkTunnelClientSocketCallbacks
} from '../../../src/shared/browser-network-tunnel-client-socket'

export const ANDROID_BROWSER_CHUNK_BYTES = 16 * 1024
export type AndroidBrowserByteStream = {
  read(): Promise<Uint8Array | null>
  write(bytes: Uint8Array | null): Promise<void>
  close(): void
}

export class AndroidBrowserTunnelSocket implements BrowserNetworkTunnelClientSocket {
  destroyed = false
  readableEnded = false
  private output: Promise<void> = Promise.resolve()
  private sink: AndroidBrowserByteStream | null = null
  private endListener = () => {}
  private eofQueued = false
  private writing = false
  private bind = () => {}
  private readonly bound = new Promise<void>((resolve) => {
    this.bind = resolve
  })

  constructor(private readonly callbacks: BrowserNetworkTunnelClientSocketCallbacks) {}

  start(sink: AndroidBrowserByteStream, initial: Uint8Array): void {
    if (this.destroyed || this.sink) {
      this.closeSink(sink)
      return
    }
    this.sink = sink
    this.bind()
    this.callbacks.requestRead()
    void this.pump(initial).catch((error: unknown) => this.fail(error))
  }

  pushBytes(bytes: Uint8Array<ArrayBufferLike> | null): boolean {
    if (this.destroyed) {
      return false
    }
    if (this.eofQueued || (bytes !== null && (!this.sink || this.writing))) {
      this.destroy(new Error('Invalid native browser output ordering'))
      return false
    }
    if (bytes === null) {
      this.eofQueued = true
    } else {
      this.writing = true
    }
    this.output = this.output
      .then(async () => {
        await this.bound
        if (this.destroyed || !this.sink) {
          return
        }
        if (bytes === null) {
          await this.sink.write(null)
          if (this.destroyed) {
            return
          }
          this.readableEnded = true
          this.endListener()
        } else {
          for (let offset = 0; offset < bytes.byteLength; offset += ANDROID_BROWSER_CHUNK_BYTES) {
            if (this.destroyed) {
              return
            }
            // Own only the slice crossing Expo, not the frame's entire backing buffer.
            await this.sink.write(bytes.slice(offset, offset + ANDROID_BROWSER_CHUNK_BYTES))
          }
          if (this.destroyed) {
            return
          }
          this.writing = false
          this.callbacks.consumeReadBytes(bytes.byteLength)
          this.callbacks.requestRead()
        }
      })
      .catch((error: unknown) => this.fail(error))
    return false
  }

  onReadableEnd(callback: () => void): void {
    this.endListener = callback
    if (this.readableEnded) {
      callback()
    }
  }

  end(): void {
    this.callbacks.finishWrite((error) => {
      if (error) {
        this.destroy(error)
      }
    })
  }

  destroy(error?: Error): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.bind()
    const sink = this.sink
    this.sink = null
    if (sink) {
      this.closeSink(sink)
    }
    this.callbacks.destroyStream(error ?? null, () => {})
  }

  private async pump(initial: Uint8Array): Promise<void> {
    let bytes: Uint8Array | null = initial
    while (!this.destroyed && this.sink) {
      if (bytes === null) {
        this.end()
        return
      }
      if (bytes.byteLength > ANDROID_BROWSER_CHUNK_BYTES) {
        throw new Error('Native read exceeded limit')
      }
      if (bytes.byteLength) {
        await new Promise<void>((resolve, reject) => {
          this.callbacks.writeBytes(bytes!, (error) => (error ? reject(error) : resolve()))
        })
      }
      if (this.destroyed || !this.sink) {
        return
      }
      bytes = await this.sink.read()
    }
  }

  private closeSink(sink: AndroidBrowserByteStream): void {
    try {
      sink.close()
    } catch {
      // Native lifetime loss must not retain core ownership.
    }
  }

  private fail(error: unknown): void {
    this.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}
