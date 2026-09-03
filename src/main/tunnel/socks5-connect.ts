import { connect, type Socket } from 'node:net'

const SOCKS_VERSION = 0x05
const NO_AUTHENTICATION = 0x00
const CONNECT = 0x01
const ADDRESS_DOMAIN = 0x03
const ADDRESS_IPV4 = 0x01
const ADDRESS_IPV6 = 0x04
const DEFAULT_TIMEOUT_MS = 30_000

const REPLY_MESSAGES: Record<number, string> = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported'
}

export type Socks5ConnectOptions = {
  proxyPort: number
  proxyHost?: string
  /** Sent as a domain name so the proxy resolves it; tailcat dials an address blob given here. */
  host: string
  port: number
  timeoutMs?: number
}

export const SOCKS5_GREETING = Buffer.from([SOCKS_VERSION, 1, NO_AUTHENTICATION])

export function encodeSocks5ConnectRequest(host: string, port: number): Buffer {
  const hostBytes = Buffer.from(host, 'utf8')
  if (hostBytes.length === 0 || hostBytes.length > 255) {
    throw new Error('SOCKS5 domain names must be 1-255 bytes')
  }
  return Buffer.concat([
    Buffer.from([SOCKS_VERSION, CONNECT, 0x00, ADDRESS_DOMAIN, hostBytes.length]),
    hostBytes,
    Buffer.from([(port >> 8) & 0xff, port & 0xff])
  ])
}

export class Socks5RefusalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Socks5RefusalError'
  }
}

/** True for a reply the proxy sent on purpose, as opposed to a dead proxy or a timeout. */
export function isSocks5RefusalError(error: unknown): boolean {
  return error instanceof Socks5RefusalError
}

export type Socks5ConnectReply =
  | { kind: 'incomplete' }
  | { kind: 'ok'; consumed: number }
  | { kind: 'error'; message: string }

/** Parses a CONNECT reply; `consumed` is the reply's byte length once it is complete. */
export function parseSocks5ConnectReply(buffer: Buffer): Socks5ConnectReply {
  if (buffer.length < 4) {
    return { kind: 'incomplete' }
  }
  if (buffer[0] !== SOCKS_VERSION) {
    return { kind: 'error', message: 'SOCKS proxy replied with an unsupported version' }
  }
  const status = buffer[1]!
  if (status !== 0x00) {
    return {
      kind: 'error',
      message: `SOCKS proxy refused the connection: ${REPLY_MESSAGES[status] ?? `reply ${status}`}`
    }
  }
  const addressType = buffer[3]
  let addressLength: number
  if (addressType === ADDRESS_IPV4) {
    addressLength = 4
  } else if (addressType === ADDRESS_IPV6) {
    addressLength = 16
  } else if (addressType === ADDRESS_DOMAIN) {
    if (buffer.length < 5) {
      return { kind: 'incomplete' }
    }
    addressLength = 1 + buffer[4]!
  } else {
    return { kind: 'error', message: 'SOCKS proxy replied with an unsupported address type' }
  }
  const total = 4 + addressLength + 2
  return buffer.length < total ? { kind: 'incomplete' } : { kind: 'ok', consumed: total }
}

/** Opens a TCP stream to `host:port` through a local SOCKS5 proxy (no authentication). */
export function connectThroughSocks5(options: Socks5ConnectOptions): Promise<Socket> {
  const request = encodeSocks5ConnectRequest(options.host, options.port)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: options.proxyHost ?? '127.0.0.1', port: options.proxyPort })
    let stage: 'greeting' | 'connect' | 'done' = 'greeting'
    let buffered = Buffer.alloc(0)

    const fail = (error: Error): void => {
      if (stage === 'done') {
        return
      }
      stage = 'done'
      cleanup()
      socket.destroy()
      reject(error)
    }
    const onTimeout = (): void => fail(new Error('Timed out negotiating with the SOCKS proxy'))
    const onClose = (): void =>
      fail(new Error('SOCKS proxy closed the connection during negotiation'))
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      if (stage === 'greeting') {
        if (buffered.length < 2) {
          return
        }
        if (buffered[0] !== SOCKS_VERSION || buffered[1] !== NO_AUTHENTICATION) {
          fail(new Error('SOCKS proxy rejected the no-authentication method'))
          return
        }
        buffered = buffered.subarray(2)
        stage = 'connect'
        socket.write(request)
      }
      if (stage === 'connect') {
        const reply = parseSocks5ConnectReply(buffered)
        if (reply.kind === 'incomplete') {
          return
        }
        if (reply.kind === 'error') {
          fail(new Socks5RefusalError(reply.message))
          return
        }
        // Why: the WebSocket server never speaks first, so bytes after the reply mean a broken proxy;
        // rejecting beats re-queuing them into a stream whose next reader is still unknown.
        if (buffered.length > reply.consumed) {
          fail(new Error('SOCKS proxy sent data before the tunnel was established'))
          return
        }
        stage = 'done'
        cleanup()
        resolve(socket)
      }
    }
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', fail)
      socket.off('close', onClose)
      socket.off('timeout', onTimeout)
      socket.setTimeout(0)
    }

    socket.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    socket.on('timeout', onTimeout)
    socket.on('error', fail)
    socket.on('close', onClose)
    socket.on('data', onData)
    socket.once('connect', () => {
      socket.write(SOCKS5_GREETING)
    })
  })
}
