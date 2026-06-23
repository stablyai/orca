import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'net'
import { resolveTailscaleSock, type TailscaleTransportResolver } from './ssh-tailscale-transport'

// Reuse a minimal success-path SOCKS5 server so resolveTailscaleSock can be
// exercised against a real proxy without the sidecar.
function startFakeSocksServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket: Socket) => {
    let phase: 'greeting' | 'request' = 'greeting'
    socket.on('data', () => {
      if (phase === 'greeting') {
        socket.write(Buffer.from([0x05, 0x00]))
        phase = 'request'
        return
      }
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port })
    })
  })
}

describe('resolveTailscaleSock', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const s of servers.splice(0)) {
      s.close()
    }
  })

  it('rejects clearly when no resolver is available', async () => {
    await expect(resolveTailscaleSock(undefined, 'h.ts.net', 22, 1000)).rejects.toThrow(
      /tailnet sidecar is not configured/
    )
  })

  it('rejects when the resolver cannot bring up the tailnet', async () => {
    const resolver: TailscaleTransportResolver = {
      resolveSocksProxy: () => Promise.reject(new Error('not logged in'))
    }
    await expect(resolveTailscaleSock(resolver, 'h.ts.net', 22, 1000)).rejects.toThrow(
      /not logged in/
    )
  })

  it('dials the destination through the resolved SOCKS5 proxy', async () => {
    const fake = await startFakeSocksServer()
    servers.push(fake.server)
    const resolver: TailscaleTransportResolver = {
      resolveSocksProxy: () => Promise.resolve({ host: '127.0.0.1', port: fake.port })
    }

    const socket = await resolveTailscaleSock(resolver, 'remote.ts.net', 22, 2000)
    expect(socket.writable).toBe(true)
    socket.destroy()
  })
})
