import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import { setTimeout } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type ClientOptions } from 'ws'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../browser/browser-local-https-test-certificate'
import { createBrowserRouteTcpEgressSocksRecorder } from '../browser/browser-route-tcp-egress-socks-recorder'
import { createProxyWebSocket } from './proxy-websocket'
import {
  applyProxySettingsToSession,
  resetProxyApplicationForTests,
  setDefaultProxySessionResolver
} from './proxy-settings'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  setDefaultProxySessionResolver(null)
  resetProxyApplicationForTests()
})

async function relayServer(tls = false) {
  const httpServer = tls
    ? createHttpsServer({ key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE })
    : createServer()
  const server = new WebSocketServer({ server: httpServer })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address')
  }
  let connections = 0
  server.on('connection', () => {
    connections += 1
  })
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) {
          client.terminate()
        }
        server.close(() => httpServer.close(() => resolve()))
      })
  )
  return {
    url: `${tls ? 'wss' : 'ws'}://127.0.0.1:${address.port}`,
    port: address.port,
    connections: () => connections
  }
}

function proxySession(route: string) {
  const session = {
    setProxy: vi.fn(async () => {}),
    resolveProxy: vi.fn(async () => route)
  }
  setDefaultProxySessionResolver(() => session)
  return session
}

function openSocket(url: string, options: ClientOptions = {}) {
  const socket = createProxyWebSocket(url, { handshakeTimeout: 1_000, ...options })
  cleanups.push(() => socket.terminate())
  return socket
}

async function connectProxy(port: number) {
  const server = createServer()
  const sockets = new Set<Socket>()
  const requests: { target: string | undefined; authorization: string | undefined }[] = []
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connect', (request, client, head) => {
    requests.push({ target: request.url, authorization: request.headers['proxy-authorization'] })
    const target = connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      target.write(head)
      client.pipe(target).pipe(client)
    })
    sockets.add(target)
    target.on('error', () => client.destroy())
    client.on('error', () => target.destroy())
    client.once('close', () => target.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address')
  }
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy()
        }
        server.close(() => resolve())
      })
  )
  return { address: `127.0.0.1:${address.port}`, requests }
}

describe('app proxy WebSockets', () => {
  it.each(['SOCKS5', 'PROXY'])('preserves TLS verification through %s', async (route) => {
    const relay = await relayServer(true)
    const hosts = new Set<string>()
    const sockets = new Set<Socket>()
    const socks = createBrowserRouteTcpEgressSocksRecorder(
      new Set([relay.port]),
      new Set(),
      hosts,
      sockets
    )
    await new Promise<void>((resolve) => socks.listen(0, '127.0.0.1', resolve))
    const address = socks.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address')
    }
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) {
            socket.destroy()
          }
          socks.close(() => resolve())
        })
    )
    const proxy =
      route === 'SOCKS5' ? `127.0.0.1:${address.port}` : (await connectProxy(relay.port)).address
    proxySession(`${route} ${proxy}`)
    const url = `wss://localhost:${relay.port}`
    await expect(once(openSocket(url), 'open')).rejects.toThrow()
    expect(relay.connections()).toBe(0)
    await once(
      openSocket(url, { ca: LOCAL_HTTPS_TEST_CERTIFICATE }),
      'open'
    )
    expect(relay.connections()).toBe(1)
    if (route === 'SOCKS5') {
      expect(hosts).toEqual(new Set(['localhost']))
    }
  })

  it('does not dial an obsolete proxy after a pending lookup is cancelled', async () => {
    const relay = await relayServer()
    const proxy = await connectProxy(relay.port)
    const session = proxySession('DIRECT')
    const route = Promise.withResolvers<string>()
    session.resolveProxy.mockImplementation(() => route.promise)
    const socket = openSocket(relay.url)
    const opening = expect(once(socket, 'open')).rejects.toThrow()
    await vi.waitFor(() => expect(session.resolveProxy).toHaveBeenCalled())
    await applyProxySettingsToSession(
      session,
      { httpProxyUrl: 'socks5h://127.0.0.1:1080' },
      { env: {} }
    )
    await opening
    route.resolve(`PROXY ${proxy.address}`)
    await setTimeout(100)
    expect(proxy.requests).toEqual([])
  })

  it('closes existing sockets when proxy settings change but preserves them on a no-op save', async () => {
    const relay = await relayServer()
    const session = proxySession('DIRECT')
    const first = openSocket(relay.url)
    await once(first, 'open')
    const settings = { httpProxyUrl: 'socks5h://127.0.0.1:1080' }
    await applyProxySettingsToSession(session, settings, { env: {} })
    await vi.waitFor(() => expect(first.readyState).toBe(first.CLOSED))

    const second = openSocket(relay.url)
    await once(second, 'open')
    await applyProxySettingsToSession(session, settings, { env: {} })
    expect(second.readyState).toBe(second.OPEN)
    await applyProxySettingsToSession(session, { httpProxyUrl: '' }, { env: {} })
    await vi.waitFor(() => expect(second.readyState).toBe(second.CLOSED))
  })

  it('honors a DIRECT bypass and preserves the headless default', async () => {
    const relay = await relayServer()
    proxySession('DIRECT')
    await once(openSocket(relay.url), 'open')
    setDefaultProxySessionResolver(null)
    await once(openSocket(relay.url), 'open')
    expect(relay.connections()).toBe(2)
  })

  it('tunnels through HTTP CONNECT with credentials only for the matching proxy', async () => {
    const relay = await relayServer()
    const proxy = await connectProxy(relay.port)
    const session = proxySession(`PROXY ${proxy.address}`)
    await applyProxySettingsToSession(
      session,
      { httpProxyUrl: `http://alice:p%2540ss@${proxy.address}` },
      { env: {} }
    )
    await once(openSocket(`ws://relay.invalid:${relay.port}`), 'open')
    expect(proxy.requests).toEqual([
      {
        target: `relay.invalid:${relay.port}`,
        authorization: `Basic ${Buffer.from('alice:p%40ss').toString('base64')}`
      }
    ])

    const other = await connectProxy(relay.port)
    session.resolveProxy.mockResolvedValue(`PROXY ${other.address}`)
    await once(openSocket(`ws://relay.invalid:${relay.port}`), 'open')
    expect(other.requests[0]?.authorization).toBeUndefined()
    expect(relay.connections()).toBe(2)
  })

  it('does not silently bypass an unavailable proxy', async () => {
    const relay = await relayServer()
    proxySession('SOCKS5 127.0.0.1:1; DIRECT')
    await expect(once(openSocket(relay.url), 'open')).rejects.toThrow()
    expect(relay.connections()).toBe(0)
  })

  it('waits for a pending proxy setting before opening the socket', async () => {
    const relay = await relayServer()
    const session = proxySession('DIRECT')
    const pending = Promise.withResolvers<void>()
    session.setProxy.mockImplementation(() => pending.promise)
    const applying = applyProxySettingsToSession(
      session,
      { httpProxyUrl: 'socks5h://127.0.0.1:1080' },
      { env: {} }
    )
    const socket = openSocket(relay.url)
    const opened = once(socket, 'open')
    await vi.waitFor(() => expect(session.setProxy).toHaveBeenCalled())
    expect(relay.connections()).toBe(0)
    expect(session.resolveProxy).not.toHaveBeenCalled()
    pending.resolve()
    await applying
    await opened
    expect(relay.connections()).toBe(1)
  })

  it('fails closed if applying the proxy setting failed', async () => {
    const relay = await relayServer()
    const session = proxySession('DIRECT')
    session.setProxy.mockRejectedValue(new Error('apply failed'))
    await expect(
      applyProxySettingsToSession(
        session,
        { httpProxyUrl: 'socks5h://127.0.0.1:1080' },
        { env: {} }
      )
    ).rejects.toThrow('apply failed')
    await expect(once(openSocket(relay.url), 'open')).rejects.toThrow(
      'Proxy settings are not ready'
    )
    expect(relay.connections()).toBe(0)
  })
})
