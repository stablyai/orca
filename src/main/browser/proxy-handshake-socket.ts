import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'

/** A stream that may still be connecting; writes made before it connects are queued. */
export type ProxyHandshakeTransport = Duplex & { setNoDelay?: (noDelay?: boolean) => unknown }

/** A tunnel socket that negotiates with a proxy over a transport before carrying destination bytes. */
export abstract class ProxyHandshakeSocket
  extends EventEmitter
  implements BrowserNetworkTunnelSocket
{
  destroyed = false
  private transport: ProxyHandshakeTransport | null = null
  private paused = false
  private noDelay: boolean | null = null
  private ready = false
  private closeEmitted = false
  private endRequested = false
  private readonly opening = new AbortController()

  /** Subclasses call this last in their constructor, after validating what they will send. */
  protected start(open: (signal: AbortSignal) => Promise<ProxyHandshakeTransport>): void {
    open(this.opening.signal).then(
      (opened) => this.attach(opened),
      (error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error)))
    )
  }

  /** Writes the opening handshake bytes. */
  protected abstract begin(): void

  /** Consumes handshake replies until it calls finishHandshake or fail. */
  protected abstract onHandshakeData(bytes: Buffer): void

  protected send(bytes: Uint8Array | string): void {
    this.transport?.write(bytes)
  }

  protected finishHandshake(remaining: Uint8Array<ArrayBufferLike>): void {
    this.ready = true
    if (this.paused) {
      this.transport?.pause()
    }
    this.emit('connect')
    if (remaining.byteLength > 0) {
      this.emit('data', remaining)
    }
  }

  setNoDelay(noDelay = true): this {
    this.noDelay = noDelay
    this.transport?.setNoDelay?.(noDelay)
    return this
  }

  pause(): this {
    this.paused = true
    if (this.ready) {
      this.transport?.pause()
    }
    return this
  }

  resume(): this {
    this.paused = false
    if (this.ready) {
      this.transport?.resume()
    }
    return this
  }

  write(bytes: Uint8Array<ArrayBufferLike>, callback?: () => void): boolean {
    if (!this.ready || this.destroyed || !this.transport) {
      callback?.()
      return false
    }
    return this.transport.write(bytes, callback)
  }

  end(): this {
    this.endRequested = true
    this.transport?.end()
    return this
  }

  destroy(): this {
    if (this.destroyed) {
      return this
    }
    this.destroyed = true
    if (this.transport) {
      this.transport.destroy()
    } else {
      this.opening.abort()
      this.emitClose()
    }
    return this
  }

  fail(error: Error): void {
    if (this.destroyed) {
      return
    }
    this.emit('error', error)
    this.destroy()
  }

  private attach(transport: ProxyHandshakeTransport): void {
    if (this.destroyed) {
      transport.destroy()
      return
    }
    this.transport = transport
    if (this.noDelay !== null) {
      transport.setNoDelay?.(this.noDelay)
    }
    transport.on('data', (bytes: Buffer | string) => {
      const chunk = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
      if (this.ready) {
        this.emit('data', chunk)
      } else {
        this.onHandshakeData(chunk)
      }
    })
    transport.on('end', () => this.emit('end'))
    transport.on('close', () => {
      this.destroyed = true
      this.emitClose()
    })
    transport.on('error', (error) => this.emit('error', error))
    this.begin()
    if (this.endRequested) {
      transport.end()
    }
  }

  private emitClose(): void {
    if (this.closeEmitted) {
      return
    }
    this.closeEmitted = true
    this.emit('close')
  }
}
