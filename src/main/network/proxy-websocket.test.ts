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
} from '../browser/electron-fixtures/browser-local-https-test-certificate'
import { createSocksProxy } from './proxy-socks.test-fixture'
import { setDefaultProxySessionResolver } from './electron-default-proxy-session'
import { PROXY_ENVIRONMENT_KEYS } from '../../shared/network-proxy'
import { createProxyWebSocket } from './proxy-websocket'
import { applyProxySettingsToSession, resetProxyApplicationForTests } from './proxy-settings'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  setDefaultProxySessionResolver(null)
  resetProxyApplicationForTests()
  vi.unstubAllEnvs()
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

async function connectProxy(port: number, tls = false) {
  const server = tls
    ? createHttpsServer({
        key: LOCAL_HTTPS_TEST_PRIVATE_KEY,
        cert: LOCAL_HTTPS_TEST_CERTIFICATE
      })
    : createServer()
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
  it.each(['CA certificate', 'ignore errors'])(
    'applies %s to both HTTPS proxy and WSS destination',
    async (mode) => {
      const relay = await relayServer(true)
      const proxy = await connectProxy(relay.port, true)
      const session = proxySession(`HTTPS ${proxy.address}`)
      await expect(once(openSocket(relay.url), 'open')).rejects.toThrow()
      expect(proxy.requests).toEqual([])
      await applyProxySettingsToSession(
        session,
        {
          httpProxyUrl: `https://${proxy.address}`,
          ...(mode === 'CA certificate'
            ? { httpProxyCaCertificate: LOCAL_HTTPS_TEST_CERTIFICATE }
            : { httpProxyIgnoreCertificateErrors: true })
        },
        { env: {} }
      )
      await once(openSocket(relay.url), 'open')
      expect(relay.connections()).toBe(1)
      expect(proxy.requests).toHaveLength(1)
    }
  )

  it('keeps hostname verification with a custom CA', async () => {
    const relay = await relayServer(true)
    const proxy = await connectProxy(relay.port)
    const session = proxySession(`PROXY ${proxy.address}`)
    await applyProxySettingsToSession(
      session,
      {
        httpProxyUrl: `http://${proxy.address}`,
        httpProxyCaCertificate: LOCAL_HTTPS_TEST_CERTIFICATE
      },
      { env: {} }
    )
    await expect(
      once(openSocket(`wss://wrong-name.invalid:${relay.port}`), 'open')
    ).rejects.toThrow(/altnames|hostname/i)
    expect(relay.connections()).toBe(0)
  })

  it.each([
    { httpProxyCaCertificate: LOCAL_HTTPS_TEST_CERTIFICATE },
    { httpProxyIgnoreCertificateErrors: true }
  ])('uses the app TLS settings for Relay: %j', async (tlsSettings) => {
    const relay = await relayServer(true)
    const proxy = await connectProxy(relay.port)
    const session = proxySession(`PROXY ${proxy.address}`)
    await applyProxySettingsToSession(
      session,
      { httpProxyUrl: `http://${proxy.address}`, ...tlsSettings },
      { env: {} }
    )
    await once(openSocket(`wss://localhost:${relay.port}`), 'open')
    expect(relay.connections()).toBe(1)
    expect(proxy.requests).toHaveLength(1)
  })

  it('revokes SSL bypass on existing and new Relay connections', async () => {
    const relay = await relayServer(true)
    const proxy = await connectProxy(relay.port)
    const session = proxySession(`PROXY ${proxy.address}`)
    const settings = {
      httpProxyUrl: `http://${proxy.address}`,
      httpProxyIgnoreCertificateErrors: true
    }
    await applyProxySettingsToSession(session, settings, { env: {} })
    const socket = openSocket(`wss://localhost:${relay.port}`)
    await once(socket, 'open')
    await applyProxySettingsToSession(
      session,
      { ...settings, httpProxyIgnoreCertificateErrors: false },
      { env: {} }
    )
    await vi.waitFor(() => expect(socket.readyState).toBe(socket.CLOSED))
    await expect(once(openSocket(`wss://localhost:${relay.port}`), 'open')).rejects.toThrow()
    expect(relay.connections()).toBe(1)
  })

  it.each(['SOCKS5', 'PROXY'])('preserves TLS verification through %s', async (route) => {
    const relay = await relayServer(true)
    const socks = await createSocksProxy(new Set([relay.port]))
    cleanups.push(socks.close)
    const proxy = route === 'SOCKS5' ? socks.address : (await connectProxy(relay.port)).address
    proxySession(`${route} ${proxy}`)
    const url = `wss://localhost:${relay.port}`
    await expect(once(openSocket(url), 'open')).rejects.toThrow()
    expect(relay.connections()).toBe(0)
    await once(openSocket(url, { ca: LOCAL_HTTPS_TEST_CERTIFICATE }), 'open')
    expect(relay.connections()).toBe(1)
    if (route === 'SOCKS5') {
      expect(socks.hosts).toEqual(new Set(['localhost']))
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

  it('honors an app DIRECT bypass and headless NO_PROXY', async () => {
    for (const key of [
      ...PROXY_ENVIRONMENT_KEYS,
      'npm_config_http_proxy',
      'npm_config_https_proxy',
      'npm_config_proxy',
      'npm_config_no_proxy'
    ]) {
      vi.stubEnv(key, '')
      vi.stubEnv(key.toUpperCase(), '')
    }
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1')
    vi.stubEnv('NO_PROXY', '127.0.0.1')
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

  it('uses HTTPS_PROXY for headless WSS upgrades and fails closed when it is unavailable', async () => {
    for (const key of [
      ...PROXY_ENVIRONMENT_KEYS,
      'npm_config_http_proxy',
      'npm_config_https_proxy',
      'npm_config_proxy',
      'npm_config_no_proxy'
    ]) {
      vi.stubEnv(key, '')
      vi.stubEnv(key.toUpperCase(), '')
    }
    const relay = await relayServer(true)
    const proxy = await connectProxy(relay.port)
    vi.stubEnv('HTTPS_PROXY', `http://${proxy.address}`)
    await once(
      openSocket(`wss://localhost:${relay.port}`, { ca: LOCAL_HTTPS_TEST_CERTIFICATE }),
      'open'
    )
    expect(proxy.requests).toEqual([
      { target: `localhost:${relay.port}`, authorization: undefined }
    ])
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1')
    await expect(
      once(openSocket(relay.url, { ca: LOCAL_HTTPS_TEST_CERTIFICATE }), 'open')
    ).rejects.toThrow(/ECONNREFUSED/)
    expect(relay.connections()).toBe(1)
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
