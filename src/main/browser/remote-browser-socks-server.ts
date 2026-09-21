import { createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

const SOCKS_VERSION = 5
const SOCKS_NO_AUTH = 0
const SOCKS_CONNECT = 1
const SOCKS_IPV4 = 1
const SOCKS_DOMAIN = 3
const SOCKS_IPV6 = 4
const MAX_HANDSHAKE_BYTES = 2048
const MAX_PENDING_UPSTREAM_BYTES = 256 * 1024
const HANDSHAKE_TIMEOUT_MS = 10_000
const SUCCESS_RESPONSE = new Uint8Array([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])

export type RemoteBrowserNetworkTarget = {
  host: string
  port: number
}

type RemoteBrowserSocksServerOptions = {
  open: (target: RemoteBrowserNetworkTarget) => Promise<Duplex>
}

type SocksRequest = {
  consumed: number
  command: number
  target: RemoteBrowserNetworkTarget
}

export class RemoteBrowserSocksServer {
  private readonly open: RemoteBrowserSocksServerOptions['open']
  private readonly server: Server
  private readonly clients = new Set<Socket>()
  private listenPromise: Promise<{ host: string; port: number }> | null = null
  private closePromise: Promise<void> | null = null
  private state: 'idle' | 'starting' | 'listening' | 'closing' | 'closed' = 'idle'

  constructor(options: RemoteBrowserSocksServerOptions) {
    this.open = options.open
    this.server = createServer((socket) => this.accept(socket))
    this.server.maxConnections = 128
  }

  listen(): Promise<{ host: string; port: number }> {
    if (this.state === 'closing' || this.state === 'closed') {
      return Promise.reject(new Error('Browser SOCKS server is closed'))
    }
    if (this.listenPromise) {
      return this.listenPromise
    }
    this.state = 'starting'
    this.listenPromise = new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.state = 'closed'
        reject(error)
      }
      this.server.once('error', onError)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', onError)
        const address = this.server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Browser SOCKS server did not bind a TCP address'))
          return
        }
        if (this.state === 'starting') {
          this.state = 'listening'
        }
        resolve({ host: '127.0.0.1', port: address.port })
      })
    })
    return this.listenPromise
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }
    this.state = 'closing'
    this.closePromise = this.closeServer()
    return this.closePromise
  }

  private async closeServer(): Promise<void> {
    if (this.listenPromise) {
      await this.listenPromise.catch(() => undefined)
    }
    for (const socket of this.clients) {
      socket.destroy()
    }
    this.clients.clear()
    if (!this.server.listening) {
      this.state = 'closed'
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
    this.state = 'closed'
  }

  private accept(socket: Socket): void {
    if (!isLoopbackAddress(socket.remoteAddress)) {
      socket.destroy()
      return
    }
    this.clients.add(socket)
    let phase: 'greeting' | 'request' | 'opening' | 'connected' | 'closed' = 'greeting'
    let buffered = Buffer.alloc(0)
    const timeout = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS)
    const cleanup = (): void => {
      phase = 'closed'
      clearTimeout(timeout)
      this.clients.delete(socket)
    }
    const finishFailure = (reply: Uint8Array): void => {
      if (phase === 'closed') {
        return
      }
      phase = 'closed'
      clearTimeout(timeout)
      buffered = Buffer.alloc(0)
      socket.pause()
      socket.end(reply, () => socket.destroy())
    }
    const fail = (replyCode: number): void => finishFailure(socksReply(replyCode))
    const onData = (chunk: Buffer): void => {
      if (phase === 'closed' || phase === 'connected') {
        return
      }
      buffered = Buffer.concat([buffered, chunk])
      if (phase === 'opening') {
        if (buffered.byteLength > MAX_PENDING_UPSTREAM_BYTES) {
          fail(1)
        }
        return
      }
      if (phase === 'greeting' && buffered.byteLength > MAX_HANDSHAKE_BYTES) {
        fail(1)
        return
      }
      if (phase === 'greeting') {
        if (buffered.byteLength < 2) {
          return
        }
        const methodCount = buffered[1]!
        if (buffered.byteLength < 2 + methodCount) {
          return
        }
        if (
          buffered[0] !== SOCKS_VERSION ||
          !buffered.subarray(2, 2 + methodCount).includes(SOCKS_NO_AUTH)
        ) {
          finishFailure(new Uint8Array([SOCKS_VERSION, 0xff]))
          return
        }
        buffered = buffered.subarray(2 + methodCount)
        socket.write(new Uint8Array([SOCKS_VERSION, SOCKS_NO_AUTH]))
        phase = 'request'
      }
      if (phase !== 'request') {
        return
      }
      const parsed = parseSocksRequest(buffered)
      if (parsed === undefined) {
        if (buffered.byteLength > MAX_HANDSHAKE_BYTES) {
          fail(1)
        }
        return
      }
      if (parsed === null) {
        fail(8)
        return
      }
      buffered = buffered.subarray(parsed.consumed)
      if (buffered.byteLength > MAX_PENDING_UPSTREAM_BYTES) {
        fail(1)
        return
      }
      if (parsed.command !== SOCKS_CONNECT) {
        fail(7)
        return
      }
      phase = 'opening'
      void Promise.resolve()
        .then(() => this.open(normalizeListenerWildcard(parsed.target)))
        .then(
          (upstream) => {
            if (phase !== 'opening' || socket.destroyed) {
              upstream.destroy()
              return
            }
            phase = 'connected'
            clearTimeout(timeout)
            socket.off('data', onData)
            socket.write(SUCCESS_RESPONSE)
            if (buffered.byteLength > 0) {
              upstream.write(buffered)
              buffered = Buffer.alloc(0)
            }
            socket.pipe(upstream)
            pipeUpstreamToClient(upstream, socket)
            upstream.once('error', () => socket.destroy())
            upstream.once('close', () => socket.destroy())
            socket.once('close', () => upstream.destroy())
          },
          () => fail(1)
        )
    }
    socket.on('data', onData)
    socket.once('error', cleanup)
    socket.once('close', cleanup)
  }
}

function pipeUpstreamToClient(upstream: Duplex, socket: Socket): void {
  upstream.on('data', (chunk: Buffer) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const accepted = socket.write(bytes, (error) => {
      if (!error && 'settleRead' in upstream && typeof upstream.settleRead === 'function') {
        upstream.settleRead(bytes.byteLength)
      }
    })
    if (!accepted) {
      upstream.pause()
    }
  })
  socket.on('drain', () => upstream.resume())
  upstream.once('end', () => socket.end())
}

function parseSocksRequest(buffer: Uint8Array): SocksRequest | null | undefined {
  if (buffer.byteLength < 4) {
    return undefined
  }
  if (buffer[0] !== SOCKS_VERSION || buffer[2] !== 0) {
    return null
  }
  const addressType = buffer[3]
  let host: string
  let addressEnd: number
  if (addressType === SOCKS_IPV4) {
    if (buffer.byteLength < 10) {
      return undefined
    }
    host = Array.from(buffer.subarray(4, 8)).join('.')
    addressEnd = 8
  } else if (addressType === SOCKS_DOMAIN) {
    if (buffer.byteLength < 5) {
      return undefined
    }
    const length = buffer[4]!
    addressEnd = 5 + length
    if (length === 0 || buffer.byteLength < addressEnd + 2) {
      return length === 0 ? null : undefined
    }
    try {
      host = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(5, addressEnd))
    } catch {
      return null
    }
  } else if (addressType === SOCKS_IPV6) {
    if (buffer.byteLength < 22) {
      return undefined
    }
    host = formatIpv6(buffer.subarray(4, 20))
    addressEnd = 20
  } else {
    return null
  }
  if (!host || buffer.byteLength < addressEnd + 2) {
    return undefined
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const port = view.getUint16(addressEnd, false)
  if (port === 0) {
    return null
  }
  return {
    consumed: addressEnd + 2,
    command: buffer[1]!,
    target: { host, port }
  }
}

function normalizeListenerWildcard(target: RemoteBrowserNetworkTarget): RemoteBrowserNetworkTarget {
  if (target.host === '0.0.0.0') {
    return { ...target, host: '127.0.0.1' }
  }
  if (target.host === '::' || target.host === '0:0:0:0:0:0:0:0') {
    return { ...target, host: '::1' }
  }
  return target
}

function formatIpv6(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: 8 }, (_, index) =>
    view.getUint16(index * 2, false).toString(16)
  ).join(':')
}

function socksReply(code: number): Uint8Array {
  const reply = SUCCESS_RESPONSE.slice()
  reply[1] = code
  return reply
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === '::1' ||
    address?.startsWith('127.') === true ||
    address?.toLowerCase().startsWith('::ffff:127.') === true
  )
}
