import { isIP } from 'node:net'
import { connect as connectTls, type ConnectionOptions } from 'node:tls'
import { separateElectronProxyCredentials } from '../network/electron-proxy-credentials'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import { ProxyHandshakeSocket, type ProxyHandshakeTransport } from './proxy-handshake-socket'

const MAX_RESPONSE_HEAD_BYTES = 16 * 1024
const HEAD_TERMINATOR = Buffer.from('\r\n\r\n')

export class HttpConnectTunnelSocket extends ProxyHandshakeSocket {
  private readonly request: string
  private head: Buffer = Buffer.alloc(0)

  /** `openTransport` reaches the proxy's own host and port; an https: proxy is wrapped in TLS here. */
  constructor(
    proxy: URL,
    target: BrowserNetworkTunnelOpen,
    openTransport: (signal: AbortSignal) => Promise<ProxyHandshakeTransport>
  ) {
    super()
    this.request = encodeConnectRequest(proxy, target)
    this.start((signal) =>
      proxy.protocol === 'https:'
        ? openTransport(signal).then((raw) => wrapTls(proxy, raw))
        : openTransport(signal)
    )
  }

  protected begin(): void {
    this.send(this.request)
  }

  protected onHandshakeData(bytes: Buffer): void {
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
    this.finishHandshake(remaining)
  }
}

function wrapTls(proxy: URL, socket: ProxyHandshakeTransport): ProxyHandshakeTransport {
  const host = proxy.hostname.replace(/^\[|\]$/g, '')
  // tls.connect supports allowHalfOpen, but its typings omit it.
  const options: ConnectionOptions & { allowHalfOpen: boolean } = {
    socket,
    // The certificate is checked against host; SNI must not carry an IP literal.
    host,
    allowHalfOpen: true,
    ...(isIP(host) ? {} : { servername: host })
  }
  return connectTls(options)
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
