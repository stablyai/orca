import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { connect as netConnect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../browser/browser-local-https-test-certificate'
import type { ProxySession } from './electron-default-proxy-session'
import {
  resetElectronProxyCredentialsForTests,
  setElectronProxyCredentialsForSession
} from './electron-proxy-credentials'
import { parseResolvedProxyRoutes, SessionProxyAgent } from './session-proxy-agent'

function fakeSession(resolved: string): ProxySession & { resolveProxy: ReturnType<typeof vi.fn> } {
  return {
    resolveProxy: vi.fn(async () => resolved),
    setProxy: async () => {}
  }
}

function port(server: HttpServer | HttpsServer): number {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP test server')
  }
  return address.port
}

async function listen<T extends HttpServer | HttpsServer>(server: T): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

describe('parseResolvedProxyRoutes', () => {
  it('keeps Chromium order and skips routes a CONNECT tunnel cannot use', () => {
    expect(
      parseResolvedProxyRoutes('SOCKS5 127.0.0.1:1080; PROXY proxy.corp:3128; HTTPS [::1]; DIRECT')
    ).toEqual([
      { kind: 'proxy', secure: false, host: 'proxy.corp', port: 3128 },
      { kind: 'proxy', secure: true, host: '::1', port: 443 },
      { kind: 'direct' }
    ])
    expect(parseResolvedProxyRoutes('DIRECT')).toEqual([{ kind: 'direct' }])
    expect(parseResolvedProxyRoutes('SOCKS 10.0.0.1:1080')).toEqual([])
  })
})

describe('SessionProxyAgent', () => {
  const servers: (HttpServer | HttpsServer)[] = []
  const sockets: WebSocket[] = []

  afterEach(async () => {
    resetElectronProxyCredentialsForTests()
    for (const socket of sockets.splice(0)) {
      socket.terminate()
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          })
      )
    )
  })

  async function startEchoRelay(): Promise<HttpsServer> {
    const server = await listen(
      createHttpsServer({ key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE })
    )
    servers.push(server)
    const wss = new WebSocketServer({ server })
    wss.on('connection', (socket) =>
      socket.on('message', (data) => socket.send(`echo:${data.toString()}`))
    )
    return server
  }

  async function startConnectProxy(status = 200): Promise<{
    server: HttpServer
    tunnels: { authority: string; authorization?: string }[]
  }> {
    const tunnels: { authority: string; authorization?: string }[] = []
    const server = await listen(createHttpServer())
    servers.push(server)
    server.on('connect', (request, client, head) => {
      tunnels.push({
        authority: request.url ?? '',
        authorization: request.headers['proxy-authorization']
      })
      if (status !== 200) {
        client.end(`HTTP/1.1 ${status} Proxy Says No\r\n\r\n`)
        return
      }
      const [host, targetPort] = (request.url ?? '').split(':')
      const upstream = netConnect(Number(targetPort), host === 'localhost' ? '127.0.0.1' : host)
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
        upstream.pipe(client).pipe(upstream)
      })
      upstream.once('error', () => client.destroy())
      client.once('error', () => upstream.destroy())
    })
    return { server, tunnels }
  }

  async function roundTrip(relayPort: number, agent: SessionProxyAgent): Promise<string> {
    const socket = new WebSocket(`wss://localhost:${relayPort}/v1/host/control`, {
      agent,
      ca: LOCAL_HTTPS_TEST_CERTIFICATE
    })
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const reply = new Promise<string>((resolve) =>
      socket.once('message', (data) => resolve(String(data)))
    )
    socket.send('ping')
    return reply
  }

  it('tunnels a wss connection through the HTTP CONNECT proxy the session resolves', async () => {
    const relay = await startEchoRelay()
    const proxy = await startConnectProxy()
    const session = fakeSession(`PROXY 127.0.0.1:${port(proxy.server)}`)

    await expect(roundTrip(port(relay), new SessionProxyAgent(session))).resolves.toBe('echo:ping')
    expect(session.resolveProxy).toHaveBeenCalledWith(`https://localhost:${port(relay)}/`)
    expect(proxy.tunnels).toEqual([{ authority: `localhost:${port(relay)}` }])
  })

  it('sends the proxy credentials Chromium was configured with', async () => {
    const relay = await startEchoRelay()
    const proxy = await startConnectProxy()
    const session = fakeSession(`PROXY 127.0.0.1:${port(proxy.server)}`)
    setElectronProxyCredentialsForSession(session, {
      host: '127.0.0.1',
      port: port(proxy.server),
      username: 'user',
      password: 'p@ss'
    })

    await roundTrip(port(relay), new SessionProxyAgent(session))
    expect(proxy.tunnels[0]?.authorization).toBe(
      `Basic ${Buffer.from('user:p@ss').toString('base64')}`
    )
  })

  it('connects directly when the session resolves DIRECT', async () => {
    const relay = await startEchoRelay()
    const proxy = await startConnectProxy()
    const session = fakeSession('DIRECT')

    await expect(roundTrip(port(relay), new SessionProxyAgent(session))).resolves.toBe('echo:ping')
    expect(proxy.tunnels).toEqual([])
  })

  it('falls back down the resolved list when a proxy is unreachable', async () => {
    const relay = await startEchoRelay()
    const dead = await listen(createHttpServer())
    const deadPort = port(dead)
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    const session = fakeSession(`PROXY 127.0.0.1:${deadPort}; DIRECT`)

    await expect(roundTrip(port(relay), new SessionProxyAgent(session))).resolves.toBe('echo:ping')
  })

  it('fails the socket instead of going direct when the proxy refuses the tunnel', async () => {
    const relay = await startEchoRelay()
    const proxy = await startConnectProxy(407)
    const session = fakeSession(`PROXY 127.0.0.1:${port(proxy.server)}; DIRECT`)

    await expect(roundTrip(port(relay), new SessionProxyAgent(session))).rejects.toThrow(
      'proxy_tunnel_rejected_407'
    )
  })
})
