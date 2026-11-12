import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { createServer, connect as connectTcp, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  connectNativeBrowserNetworkTarget,
  resolveNativeBrowserNetworkExecutionRoute
} from '../execution-routes/browser-network-execution-route'
import { setNetworkProxySettingsSource } from '../execution-routes/browser-network-proxy-settings-source'
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

  it('reports a proxy refusal as a connect failure instead of falling back to direct', async () => {
    const proxy = await startConnectProxy(await startEchoServer(), { reject: 403 })
    const socket = connectNativeBrowserNetworkTarget(
      { host: 'blocked.invalid', port: 443 },
      { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }
    )
    await expect(roundTrip(socket, 'c')).rejects.toThrow('http_proxy_connect_rejected:403')
  })
})
