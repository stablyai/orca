import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { createServer, connect as connectTcp, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  connectNativeBrowserNetworkTarget,
  resolveNativeBrowserNetworkExecutionRoute
} from './browser-network-execution-route'
import { setNetworkProxySettingsSource } from './browser-network-proxy-settings-source'
import {
  matchesProxyBypassRules,
  selectBrowserNetworkTunnelProxy
} from './browser-network-tunnel-proxy-selection'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  setNetworkProxySettingsSource(null)
  await Promise.all(closers.splice(0).map((close) => close()))
})

function listen<T extends Server | ReturnType<typeof createServer>>(server: T): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
    closers.push(() => new Promise((done) => server.close(() => done())))
  })
}

async function startEchoServer(): Promise<number> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('data', (bytes: Buffer) => socket.write(Buffer.concat([Buffer.from('echo:'), bytes])))
    socket.on('close', () => sockets.delete(socket))
  })
  closers.push(async () => sockets.forEach((socket) => socket.destroy()))
  return listen(server)
}

type ConnectRecord = { authority: string; authorization?: string }

async function startConnectProxy(
  echoPort: number,
  options: { reject?: number } = {}
): Promise<{ port: number; requests: ConnectRecord[] }> {
  const requests: ConnectRecord[] = []
  const sockets = new Set<Socket>()
  const server = createHttpServer()
  server.on('connect', (request: IncomingMessage, client: Socket) => {
    sockets.add(client)
    requests.push({
      authority: request.url ?? '',
      authorization: request.headers['proxy-authorization']
    })
    if (options.reject) {
      client.end(`HTTP/1.1 ${options.reject} Forbidden\r\n\r\n`)
      return
    }
    const upstream = connectTcp(echoPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(client)
      client.pipe(upstream)
    })
    sockets.add(upstream)
  })
  closers.push(async () => sockets.forEach((socket) => socket.destroy()))
  return { port: await listen(server), requests }
}

function roundTrip(socket: BrowserNetworkTunnelSocket, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.on('error', reject)
    socket.on('connect', () => socket.write(Buffer.from(payload)))
    socket.on('data', (bytes) => {
      resolve(Buffer.from(bytes).toString())
      socket.destroy()
    })
  })
}

describe('native browser tunnel upstream proxy (#29154)', () => {
  it('reaches a destination through HTTPS_PROXY with CONNECT', async () => {
    const proxy = await startConnectProxy(await startEchoServer())
    vi.stubEnv('HTTPS_PROXY', `http://user:p%40ss@127.0.0.1:${proxy.port}`)
    const route = resolveNativeBrowserNetworkExecutionRoute({
      executionHost: { kind: 'native', runtimeId: 'runtime-1', revision: 1 },
      runtimeId: 'runtime-1',
      runtimeRevision: 1
    })
    const socket = route.connect({ host: 'only-via-proxy.invalid', port: 443 })
    await expect(roundTrip(socket, 'hello')).resolves.toBe('echo:hello')
    expect(proxy.requests).toEqual([
      {
        authority: 'only-via-proxy.invalid:443',
        authorization: `Basic ${Buffer.from('user:p@ss').toString('base64')}`
      }
    ])
  })

  it('sends a credential that is not valid percent-encoding as written', async () => {
    const proxy = await startConnectProxy(await startEchoServer())
    const socket = connectNativeBrowserNetworkTarget(
      { host: 'site.invalid', port: 443 },
      { HTTPS_PROXY: `http://user:p%ss@127.0.0.1:${proxy.port}` }
    )
    await expect(roundTrip(socket, 'd')).resolves.toBe('echo:d')
    expect(proxy.requests[0]?.authorization).toBe(
      `Basic ${Buffer.from('user:p%ss').toString('base64')}`
    )
  })

  it("prefers Orca's proxy setting and its bypass list over the environment", async () => {
    const proxy = await startConnectProxy(await startEchoServer())
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: `http://127.0.0.1:${proxy.port}`,
      httpProxyBypassRules: 'internal.test'
    }))
    const socket = connectNativeBrowserNetworkTarget(
      { host: 'site.invalid', port: 80 },
      { HTTPS_PROXY: 'http://127.0.0.1:1' }
    )
    await expect(roundTrip(socket, 'a')).resolves.toBe('echo:a')
    expect(proxy.requests.map((request) => request.authority)).toEqual(['site.invalid:80'])
  })

  it('dials NO_PROXY and loopback destinations directly', async () => {
    const echoPort = await startEchoServer()
    const proxy = await startConnectProxy(echoPort)
    const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: 'example.test' }
    const socket = connectNativeBrowserNetworkTarget({ host: '127.0.0.1', port: echoPort }, env)
    await expect(roundTrip(socket, 'b')).resolves.toBe('echo:b')
    expect(proxy.requests).toEqual([])
    expect(
      selectBrowserNetworkTunnelProxy({ host: 'a.example.test', port: 443 }, null, env)
    ).toEqual({ kind: 'direct' })
    for (const host of ['localhost.', 'app.localhost.', '::1', '0:0:0:0:0:0:0:1', '127.1.2.3']) {
      expect(selectBrowserNetworkTunnelProxy({ host, port: 3000 }, null, env)).toEqual({
        kind: 'direct'
      })
    }
  })

  it('reports a proxy refusal as a connect failure instead of falling back to direct', async () => {
    const proxy = await startConnectProxy(await startEchoServer(), { reject: 403 })
    const socket = connectNativeBrowserNetworkTarget(
      { host: 'blocked.invalid', port: 443 },
      { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }
    )
    await expect(roundTrip(socket, 'c')).rejects.toThrow('http_proxy_connect_rejected:403')
  })

  it('refuses a proxy kind it cannot speak rather than bypassing it', () => {
    expect(() =>
      connectNativeBrowserNetworkTarget(
        { host: 'site.invalid', port: 443 },
        { ALL_PROXY: 'socks4://127.0.0.1:1080' }
      )
    ).toThrow('browser_tunnel_proxy_unsupported')
    expect(
      selectBrowserNetworkTunnelProxy({ host: 'site.invalid', port: 443 }, null, {
        ALL_PROXY: 'socks5://127.0.0.1:1080'
      })
    ).toMatchObject({ kind: 'socks5' })
  })

  it('dials directly with no proxy configured', () => {
    expect(selectBrowserNetworkTunnelProxy({ host: 'site.invalid', port: 443 }, null, {})).toEqual({
      kind: 'direct'
    })
  })
})

describe('proxy bypass rules', () => {
  it.each([
    ['*', 'any.host', 443, true, true],
    ['<local>', 'intranet', 80, true, true],
    ['<local>', 'intranet.corp', 80, false, false],
    ['.corp.test', 'a.corp.test', 443, true, true],
    ['.corp.test', 'corp.test', 443, true, false],
    ['*.corp.test', 'corp.test', 443, true, false],
    ['*corp.test', 'corp.test', 443, true, true],
    ['corp.test', 'deep.a.corp.test', 443, true, false],
    ['corp.test', 'corp.test', 443, true, true],
    ['corp.test', 'notcorp.test', 443, false, false],
    ['corp.test:8443', 'corp.test', 443, false, false],
    ['corp.test:8443', 'corp.test', 8443, true, true],
    ['10.0.0.0/8', '10.20.30.40', 443, true, true],
    ['10.0.0.0/8', '11.0.0.1', 443, false, false],
    ['[fd00::1]', 'fd00::1', 443, true, true],
    ['[fd00::1]', 'fd00:0:0:0:0:0:0:1', 443, true, true],
    ['fd00:0::1', '[FD00::1]', 443, true, true],
    ['https://corp.test', 'corp.test', 443, true, true],
    ['https://corp.test', 'corp.test', 80, false, false],
    ['ftp://corp.test', 'corp.test', 21, false, false],
    ['fc00::/7', 'fd00::123', 443, true, true],
    ['fc00::/7', '2001:db8::1', 443, false, false],
    ['192.168.*', '192.168.4.20', 443, true, true],
    ['api.*.corp.test', 'api.eu.corp.test', 443, true, true],
    ['api.*.corp.test', 'web.eu.corp.test', 443, false, false],
    ['corp.test', 'corp.test.', 443, true, true],
    ['', '169.254.169.254', 80, true, true],
    ['<-loopback>', 'localhost', 3000, false, false],
    ['<-loopback>;<local>', 'localhost', 3000, true, true],
    ['<local>;<-loopback>', 'localhost', 3000, false, false],
    ['<local>;<-loopback>', 'intranet', 80, true, true]
  ])('%s against %s:%d (NO_PROXY %s, Chromium %s)', (rule, host, port, noProxy, chromium) => {
    expect(matchesProxyBypassRules({ host, port }, rule, 'no-proxy')).toBe(noProxy)
    expect(matchesProxyBypassRules({ host, port }, rule, 'chromium')).toBe(chromium)
  })

  it('proxies loopback destinations when the bypass list subtracts them', () => {
    const settings = { httpProxyUrl: 'http://proxy.test:8080', httpProxyBypassRules: '<-loopback>' }
    const target = { host: '127.0.0.1', port: 3000 }
    expect(selectBrowserNetworkTunnelProxy(target, settings, {})).toMatchObject({ kind: 'http' })
  })
})
