import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import { ProxyHandshakeSocket, type ProxyHandshakeTransport } from './proxy-handshake-socket'

const SOCKS_VERSION = 5
const SOCKS_NO_AUTH = 0
const SOCKS_CONNECT = 1
const SOCKS_DOMAIN = 3
const MAX_HANDSHAKE_BYTES = 512

export class SystemSshSocksClientSocket extends ProxyHandshakeSocket {
  private readonly connectRequest: Uint8Array
  private handshake: Uint8Array<ArrayBufferLike> = new Uint8Array()
  private phase: 'method' | 'connect' = 'method'

  /** `openTransport` reaches a no-auth SOCKS5 server, such as the local end of `ssh -D`. */
  constructor(
    target: BrowserNetworkTunnelOpen,
    openTransport: (signal: AbortSignal) => Promise<ProxyHandshakeTransport>
  ) {
    super()
    this.connectRequest = encodeConnectRequest(target)
    this.start(openTransport)
  }

  protected begin(): void {
    this.send(new Uint8Array([SOCKS_VERSION, 1, SOCKS_NO_AUTH]))
  }

  protected onHandshakeData(bytes: Buffer): void {
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
      this.send(this.connectRequest)
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
    this.finishHandshake(remaining)
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
