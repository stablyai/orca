import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  connectThroughSocks5,
  encodeSocks5ConnectRequest,
  parseSocks5ConnectReply,
  SOCKS5_GREETING
} from './socks5-connect'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

function listen(onConnection: (socket: Socket) => void): Promise<number> {
  const server = createServer(onConnection)
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

/** Minimal SOCKS5 server: no auth, then a scripted CONNECT reply followed by optional payload. */
function fakeSocksServer(args: {
  reply: Buffer
  onRequest?: (request: Buffer) => void
  trailing?: Buffer
}): Promise<number> {
  return listen((socket) => {
    let stage: 'greeting' | 'connect' | 'relay' = 'greeting'
    socket.on('data', (chunk: Buffer) => {
      if (stage === 'greeting') {
        expect(chunk.equals(SOCKS5_GREETING)).toBe(true)
        socket.write(Buffer.from([5, 0]))
        stage = 'connect'
        return
      }
      if (stage === 'connect') {
        args.onRequest?.(chunk)
        stage = 'relay'
        socket.write(args.trailing ? Buffer.concat([args.reply, args.trailing]) : args.reply)
        return
      }
      socket.write(Buffer.from(`echo:${chunk.toString()}`))
    })
  })
}

const OK_REPLY_IPV4 = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0x1a, 0x70])

describe('encodeSocks5ConnectRequest', () => {
  it('encodes the destination as a domain name with a big-endian port', () => {
    const request = encodeSocks5ConnectRequest('tcABC', 6768)
    expect([...request]).toEqual([5, 1, 0, 3, 5, ...Buffer.from('tcABC'), 0x1a, 0x70])
  })

  it('refuses names the one-byte length field cannot carry', () => {
    expect(() => encodeSocks5ConnectRequest('a'.repeat(256), 1)).toThrow(/1-255 bytes/)
  })
})

describe('parseSocks5ConnectReply', () => {
  it('reports incomplete replies until the bound address arrives', () => {
    expect(parseSocks5ConnectReply(OK_REPLY_IPV4.subarray(0, 6))).toEqual({ kind: 'incomplete' })
    expect(parseSocks5ConnectReply(OK_REPLY_IPV4)).toEqual({ kind: 'ok', consumed: 10 })
  })

  it('sizes domain and IPv6 bound addresses', () => {
    const domain = Buffer.from([5, 0, 0, 3, 3, ...Buffer.from('abc'), 0, 80])
    expect(parseSocks5ConnectReply(domain)).toEqual({ kind: 'ok', consumed: 10 })
    const ipv6 = Buffer.from([5, 0, 0, 4, ...Buffer.alloc(16), 0, 80])
    expect(parseSocks5ConnectReply(ipv6)).toEqual({ kind: 'ok', consumed: 22 })
  })

  it('maps refusal codes to messages', () => {
    expect(parseSocks5ConnectReply(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]))).toEqual({
      kind: 'error',
      message: 'SOCKS proxy refused the connection: connection refused'
    })
  })
})

describe('connectThroughSocks5', () => {
  it('returns a socket that relays after the handshake', async () => {
    let request: Buffer | null = null
    const proxyPort = await fakeSocksServer({
      reply: OK_REPLY_IPV4,
      onRequest: (chunk) => {
        request = chunk
      }
    })
    const socket = await connectThroughSocks5({ proxyPort, host: 'tcTOKEN', port: 6768 })
    expect(request).not.toBeNull()
    expect(request!.equals(encodeSocks5ConnectRequest('tcTOKEN', 6768))).toBe(true)
    const received = await new Promise<string>((resolve) => {
      let collected = ''
      socket.on('data', (chunk) => {
        collected += chunk.toString()
        if (collected.includes('echo:hi')) {
          resolve(collected)
        }
      })
      socket.write('hi')
    })
    expect(received).toBe('echo:hi')
    socket.destroy()
  })

  it('rejects a proxy that sends payload before the tunnel is up', async () => {
    const proxyPort = await fakeSocksServer({
      reply: OK_REPLY_IPV4,
      trailing: Buffer.from('early')
    })
    await expect(connectThroughSocks5({ proxyPort, host: 'tcTOKEN', port: 1 })).rejects.toThrow(
      /before the tunnel/
    )
  })

  it('rejects when the proxy refuses the destination', async () => {
    const proxyPort = await fakeSocksServer({
      reply: Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])
    })
    await expect(connectThroughSocks5({ proxyPort, host: 'tcTOKEN', port: 1 })).rejects.toThrow(
      /host unreachable/
    )
  })

  it('rejects when the proxy closes mid-handshake', async () => {
    const proxyPort = await listen((socket) => socket.destroy())
    await expect(connectThroughSocks5({ proxyPort, host: 'tcTOKEN', port: 1 })).rejects.toThrow(
      /closed the connection|ECONNRESET/
    )
  })
})
