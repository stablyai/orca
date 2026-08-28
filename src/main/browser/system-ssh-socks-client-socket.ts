import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'

const SOCKS_VERSION = 5
const SOCKS_NO_AUTH = 0
const SOCKS_CONNECT = 1
const SOCKS_DOMAIN = 3
const MAX_HANDSHAKE_BYTES = 512

export class SystemSshSocksClientSocket extends EventEmitter implements BrowserNetworkTunnelSocket {
  destroyed = false
  private readonly socket: Socket
  private readonly connectRequest: Uint8Array
  private paused = false
  private handshake: Uint8Array<ArrayBufferLike> = new Uint8Array()
  private phase: 'method' | 'connect' | 'ready' = 'method'

  constructor(localPort: number, target: BrowserNetworkTunnelOpen) {
    super()
    this.connectRequest = encodeConnectRequest(target)
    this.socket = connect({ host: '127.0.0.1', port: localPort, allowHalfOpen: true })
    this.socket.once('connect', () => {
      this.socket.write(new Uint8Array([SOCKS_VERSION, 1, SOCKS_NO_AUTH]))
    })
    this.socket.on('data', (bytes) =>
      this.onHandshakeData(typeof bytes === 'string' ? Buffer.from(bytes) : bytes)
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
    if (this.phase === 'ready') {
      this.socket.pause()
    }
    return this
  }

  resume(): this {
    this.paused = false
    if (this.phase === 'ready') {
      this.socket.resume()
    }
    return this
  }

  write(bytes: Uint8Array<ArrayBufferLike>, callback?: () => void): boolean {
    if (this.phase !== 'ready' || this.destroyed) {
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

  fail(error: Error): void {
    if (this.destroyed) {
      return
    }
    this.emit('error', error)
    this.socket.destroy()
  }

  private onHandshakeData(bytes: Buffer): void {
    if (this.phase === 'ready') {
      this.emit('data', bytes)
      return
    }
    this.handshake = appendBytes(this.handshake, bytes)
    if (this.handshake.byteLength > MAX_HANDSHAKE_BYTES) {
      this.fail(new Error('system_ssh_socks_handshake_overflow'))
      return
    }
    if (this.phase === 'method') {
      if (this.handshake.byteLength < 2) {
        return
      }
      if (this.handshake[0] !== SOCKS_VERSION || this.handshake[1] !== SOCKS_NO_AUTH) {
        this.fail(new Error('system_ssh_socks_auth_rejected'))
        return
      }
      this.handshake = this.handshake.slice(2)
      this.phase = 'connect'
      this.socket.write(this.connectRequest)
    }
    this.finishConnectHandshake()
  }

  private finishConnectHandshake(): void {
    const replyLength = socksReplyLength(this.handshake)
    if (replyLength === null) {
      return
    }
    if (
      replyLength < 0 ||
      this.handshake[0] !== SOCKS_VERSION ||
      this.handshake[1] !== 0 ||
      this.handshake[2] !== 0
    ) {
      this.fail(new Error('system_ssh_socks_connect_rejected'))
      return
    }
    const remaining = this.handshake.slice(replyLength)
    this.handshake = new Uint8Array()
    this.phase = 'ready'
    if (this.paused) {
      this.socket.pause()
    }
    this.emit('connect')
    if (remaining.byteLength > 0) {
      this.emit('data', remaining)
    }
  }
}

function encodeConnectRequest(target: BrowserNetworkTunnelOpen): Uint8Array {
  const host = new TextEncoder().encode(target.host)
  if (host.byteLength === 0 || host.byteLength > 255) {
    throw new Error('system_ssh_socks_target_invalid')
  }
  return new Uint8Array([
    SOCKS_VERSION,
    SOCKS_CONNECT,
    0,
    SOCKS_DOMAIN,
    host.byteLength,
    ...host,
    (target.port >>> 8) & 0xff,
    target.port & 0xff
  ])
}

function socksReplyLength(bytes: Uint8Array<ArrayBufferLike>): number | null {
  if (bytes.byteLength < 5) {
    return null
  }
  const addressType = bytes[3]
  if (addressType === 1) {
    return bytes.byteLength >= 10 ? 10 : null
  }
  if (addressType === SOCKS_DOMAIN) {
    const length = 7 + bytes[4]!
    return bytes.byteLength >= length ? length : null
  }
  if (addressType === 4) {
    return bytes.byteLength >= 22 ? 22 : null
  }
  return -1
}

function appendBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBufferLike> {
  const combined = new Uint8Array(left.byteLength + right.byteLength)
  combined.set(left)
  combined.set(right, left.byteLength)
  return combined
}
