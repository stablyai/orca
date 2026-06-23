import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'net'
import { once } from 'events'
import { dialThroughSocks5 } from './ssh-tailscale-dialer'

// Minimal SOCKS5 server for tests. It accepts the no-auth greeting, answers the
// CONNECT request with the configured reply code, and (on success) echoes any
// subsequent bytes back so callers can prove the tunnel is live.
type FakeSocksOptions = {
  replyCode?: number
  /** Bytes to emit immediately after the success reply, in the same write —
   *  simulates a proxy that ships early tunnel data alongside the reply. */
  earlyTunnelData?: Buffer
}

function startFakeSocksServer(options: FakeSocksOptions = {}): Promise<{
  server: Server
  port: number
  lastRequest: () => Buffer | null
}> {
  const replyCode = options.replyCode ?? 0x00
  let lastRequest: Buffer | null = null

  const server = createServer((socket: Socket) => {
    let phase: 'greeting' | 'request' | 'tunnel' = 'greeting'
    socket.on('data', (chunk: Buffer) => {
      if (phase === 'greeting') {
        socket.write(Buffer.from([0x05, 0x00]))
        phase = 'request'
        return
      }
      if (phase === 'request') {
        lastRequest = chunk
        const reply = Buffer.from([0x05, replyCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        socket.write(
          options.earlyTunnelData ? Buffer.concat([reply, options.earlyTunnelData]) : reply
        )
        if (replyCode === 0x00) {
          phase = 'tunnel'
        } else {
          socket.end()
        }
        return
      }
      // tunnel: echo
      socket.write(chunk)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, port, lastRequest: () => lastRequest })
    })
  })
}

describe('dialThroughSocks5', () => {
  const servers: Server[] = []

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.close()
    }
  })

  it('completes the handshake and tunnels bytes end to end', async () => {
    const fake = await startFakeSocksServer()
    servers.push(fake.server)

    const socket = await dialThroughSocks5(
      { host: '127.0.0.1', port: fake.port },
      'remote.ts.net',
      22
    )

    // The proxy received a domain-typed CONNECT for the requested destination.
    const request = fake.lastRequest()
    expect(request).not.toBeNull()
    expect(request![3]).toBe(0x03) // ATYP domain
    expect(request!.subarray(5, 5 + request![4]).toString()).toBe('remote.ts.net')

    socket.write('ping')
    const [echoed] = (await once(socket, 'data')) as [Buffer]
    expect(echoed.toString()).toBe('ping')
    socket.destroy()
  })

  it('delivers early tunnel data sent alongside the reply', async () => {
    const fake = await startFakeSocksServer({ earlyTunnelData: Buffer.from('SSH-2.0-banner') })
    servers.push(fake.server)

    const socket = await dialThroughSocks5(
      { host: '127.0.0.1', port: fake.port },
      'remote.ts.net',
      22
    )
    const [first] = (await once(socket, 'data')) as [Buffer]
    expect(first.toString()).toBe('SSH-2.0-banner')
    socket.destroy()
  })

  it('rejects with the mapped errno when the proxy refuses the connection', async () => {
    const fake = await startFakeSocksServer({ replyCode: 0x05 })
    servers.push(fake.server)

    await expect(
      dialThroughSocks5({ host: '127.0.0.1', port: fake.port }, 'remote.ts.net', 22)
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('rejects when the proxy is unreachable', async () => {
    // Port 1 on loopback is reserved/closed; the TCP connect itself fails.
    await expect(
      dialThroughSocks5({ host: '127.0.0.1', port: 1 }, 'remote.ts.net', 22, { timeoutMs: 2000 })
    ).rejects.toThrow()
  })

  it('rejects when the handshake stalls past the timeout', async () => {
    // A server that accepts the socket but never replies to the greeting.
    const stall = createServer(() => {})
    servers.push(stall)
    await new Promise<void>((resolve) => stall.listen(0, '127.0.0.1', resolve))
    const port = (stall.address() as { port: number }).port

    await expect(
      dialThroughSocks5({ host: '127.0.0.1', port }, 'remote.ts.net', 22, { timeoutMs: 100 })
    ).rejects.toThrow(/timed out/)
  })
})
