import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'

type DeferredSocketSource = Duplex & { setNoDelay?: (noDelay?: boolean) => unknown }

export class BrowserNetworkDeferredSocket
  extends EventEmitter
  implements BrowserNetworkTunnelSocket
{
  destroyed = false
  private source: DeferredSocketSource | null = null
  private paused = false
  private noDelay = false
  private closeEmitted = false

  attach(source: DeferredSocketSource): void {
    if (this.destroyed || this.source) {
      source.destroy()
      return
    }
    this.source = source
    source.setNoDelay?.(this.noDelay)
    source.on('data', (bytes) => this.emit('data', bytes))
    source.on('end', () => this.emit('end'))
    source.on('close', () => {
      this.destroyed = true
      this.emitClose()
    })
    source.on('error', (error) => this.emit('error', error))
    if (this.paused) {
      source.pause()
    } else {
      source.resume()
    }
    queueMicrotask(() => {
      if (!this.destroyed && this.source === source) {
        this.emit('connect')
      }
    })
  }

  fail(error: Error): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.emit('error', error)
    this.emitClose()
  }

  setNoDelay(noDelay = true): this {
    this.noDelay = noDelay
    this.source?.setNoDelay?.(noDelay)
    return this
  }

  pause(): this {
    this.paused = true
    this.source?.pause()
    return this
  }

  resume(): this {
    this.paused = false
    this.source?.resume()
    return this
  }

  write(bytes: Uint8Array<ArrayBufferLike>, callback?: () => void): boolean {
    if (!this.source || this.destroyed) {
      callback?.()
      return false
    }
    return this.source.write(bytes, callback)
  }

  end(): this {
    this.source?.end()
    return this
  }

  destroy(): this {
    if (this.destroyed) {
      return this
    }
    this.destroyed = true
    this.source?.destroy()
    this.emitClose()
    return this
  }

  private emitClose(): void {
    if (this.closeEmitted) {
      return
    }
    this.closeEmitted = true
    this.emit('close')
  }
}
