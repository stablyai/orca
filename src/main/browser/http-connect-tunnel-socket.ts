import { EventEmitter } from 'node:events'
import { connect, isIP, type Socket } from 'node:net'
import { connect as connectTls, type ConnectionOptions } from 'node:tls'
import { separateElectronProxyCredentials } from '../network/electron-proxy-credentials'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'

const MAX_RESPONSE_HEAD_BYTES = 16 * 1024
const HEAD_TERMINATOR = Buffer.from('\r\n\r\n')

export class HttpConnectTunnelSocket extends EventEmitter implements BrowserNetworkTunnelSocket {
  destroyed = false
  private readonly socket: Socket
  private paused = false
  private head: Buffer = Buffer.alloc(0)
  private ready = false

  constructor(proxy: URL, target: BrowserNetworkTunnelOpen) {
    super()
    const request = encodeConnectRequest(proxy, target)
    const port = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)
    const host = proxy.hostname.replace(/^\[|\]$/g, '')
    const onConnected = (): void => {
      this.socket.write(request)
    }
    // tls.connect supports allowHalfOpen, but its typings omit it.
    const tlsOptions: ConnectionOptions & { allowHalfOpen: boolean } = {
      host,
      port,
      allowHalfOpen: true,
      ...(isIP(host) ? {} : { servername: host })
    }
    this.socket =
      proxy.protocol === 'https:'
        ? connectTls(tlsOptions, onConnected)
        : connect({ host, port, allowHalfOpen: true }, onConnected)
    this.socket.on('data', (bytes: Buffer | string) =>
      this.onData(typeof bytes === 'string' ? Buffer.from(bytes) : bytes)
    )
    this.socket.on('end', () => this.emit('end'))
    this.socket.on('close', () => {
      this.destroyed = true
      this.emit('close')
    })
    this.socket.on('error', (error) => this.emit('error', error))
  }

  setNoDelay(noDelay = true): this {
    this.socket.setNoDelay(noDelay)
    return this
  }

  pause(): this {
    this.paused = true
    if (this.ready) {
      this.socket.pause()
    }
    return this
  }

  resume(): this {
    this.paused = false
    if (this.ready) {
      this.socket.resume()
    }
    return this
  }

  write(bytes: Uint8Array<ArrayBufferLike>, callback?: () => void): boolean {
    if (!this.ready || this.destroyed) {
      callback?.()
      return false
    }
    return this.socket.write(bytes, callback)
  }

  end(): this {
    this.socket.end()
    return this
  }

  destroy(): this {
    this.destroyed = true
    this.socket.destroy()
    return this
  }

  private fail(error: Error): void {
    if (this.destroyed) {
      return
    }
    this.emit('error', error)
    this.socket.destroy()
  }

  private onData(bytes: Buffer): void {
    if (this.ready) {
      this.emit('data', bytes)
      return
    }
    this.head = Buffer.concat([this.head, bytes])
    const end = this.head.indexOf(HEAD_TERMINATOR)
    if (end === -1) {
      if (this.head.byteLength > MAX_RESPONSE_HEAD_BYTES) {
        this.fail(new Error('http_proxy_response_too_large'))
      }
      return
    }
    const statusLine = this.head.subarray(0, this.head.indexOf('\r\n')).toString('latin1')
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]
    if (!status?.startsWith('2')) {
      this.fail(new Error(`http_proxy_connect_rejected:${status ?? 'malformed'}`))
      return
    }
    const remaining = this.head.subarray(end + HEAD_TERMINATOR.byteLength)
    this.head = Buffer.alloc(0)
    this.ready = true
    if (this.paused) {
      this.socket.pause()
    }
    this.emit('connect')
    if (remaining.byteLength > 0) {
      this.emit('data', remaining)
    }
  }
}

function encodeConnectRequest(proxy: URL, target: BrowserNetworkTunnelOpen): string {
  const host = isIP(target.host) === 6 ? `[${target.host}]` : target.host
  if (!host || /[\s\r\n]/.test(host)) {
    throw new Error('http_proxy_target_invalid')
  }
  const authority = `${host}:${target.port}`
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
  const { credentials } = separateElectronProxyCredentials(proxy.toString())
  if (credentials) {
    const basic = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')
    lines.push(`Proxy-Authorization: Basic ${basic}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}
