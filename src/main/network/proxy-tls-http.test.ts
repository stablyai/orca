import { createServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { connect, type Socket } from 'node:net'
import { getCACertificates } from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../browser/electron-fixtures/browser-local-https-test-certificate'
import { electronHttpClient } from '../host/electron-http-client'
import { applyProxySettingsToSession, resetProxyApplicationForTests } from './proxy-settings'
import { createSocksProxy } from './proxy-socks.test-fixture'

const { session, chromiumFetch } = vi.hoisted(() => ({
  session: {
    setProxy: vi.fn(async () => {}),
    resolveProxy: vi.fn(async () => 'DIRECT'),
    getUserAgent: () => 'Orca-test-Chromium'
  },
  chromiumFetch: vi.fn((url: string, init?: RequestInit) => globalThis.fetch(url, init))
}))
vi.mock('electron', () => ({ net: { fetch: chromiumFetch }, session: { defaultSession: session } }))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  resetProxyApplicationForTests()
  vi.clearAllMocks()
  session.resolveProxy.mockResolvedValue('DIRECT')
})

async function endpoint(redirectTarget = '/secret-target') {
  const requests: { url?: string; authorization?: string; userAgent?: string; body: string }[] = []
  let streamClosed = false
  const server = createServer(
    { key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE },
    async (request, response) => {
      let body = ''
      for await (const chunk of request) {
        body += chunk.toString()
      }
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        userAgent: request.headers['user-agent'],
        body
      })
      if (request.url === '/stream') {
        response.writeHead(200)
        response.write('first chunk')
        response.once('close', () => {
          streamClosed = true
        })
      } else if (request.url === '/empty') {
        response.writeHead(204)
        response.end()
      } else if (request.url === '/redirect' || request.url === '/redirect307') {
        response.writeHead(request.url === '/redirect307' ? 307 : 302, { location: redirectTarget })
        response.end()
      } else {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"connected":true}')
      }
    }
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address')
  }
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  return {
    url: `https://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    streamClosed: () => streamClosed
  }
}

async function tunnel(port: number, route: string) {
  if (route === 'SOCKS5') {
    const proxy = await createSocksProxy(new Set([port]))
    cleanups.push(proxy.close)
    return { ...proxy, requests: [] }
  }
  const sockets = new Set<Socket>()
  const hosts = new Set<string>()
  const requests: (string | undefined)[] = []
  const http =
    route === 'HTTPS'
      ? createServer({ key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE })
      : createHttpServer()
  http.on('connect', (request, client, head) => {
    requests.push(request.url)
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
  const proxy = http
  proxy.on('connection', (socket) => sockets.add(socket))
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address')
  }
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy()
        }
        proxy.close(() => resolve())
      })
  )
  return { address: `127.0.0.1:${address.port}`, requests, hosts }
}

describe('Cloud and Relay HTTP TLS settings', () => {
  it('does not forward authorization across a redirect to another origin', async () => {
    const destination = await endpoint()
    const source = await endpoint(destination.url)
    await applyProxySettingsToSession(
      session,
      { httpProxyCaCertificate: LOCAL_HTTPS_TEST_CERTIFICATE },
      { env: {} }
    )
    const response = await electronHttpClient.fetch(`${source.url}/redirect`, {
      headers: { authorization: 'Bearer redirect-test' }
    })
    await response.text()
    expect(source.requests[0].authorization).toBe('Bearer redirect-test')
    expect(destination.requests[0].authorization).toBeUndefined()
  })

  it.each(['PROXY', 'HTTPS', 'SOCKS5'])(
    'uses custom CA trust through %s while preserving proxy routing',
    async (route) => {
      const server = await endpoint()
      const proxy = await tunnel(server.port, route)
      session.resolveProxy.mockResolvedValue(`${route} ${proxy.address}`)
      const scheme = route === 'HTTPS' ? 'https' : route === 'SOCKS5' ? 'socks5h' : 'http'
      await applyProxySettingsToSession(
        session,
        {
          httpProxyUrl: `${scheme}://${proxy.address}`,
          httpProxyCaCertificate: LOCAL_HTTPS_TEST_CERTIFICATE
        },
        { env: {} }
      )
      const response = await electronHttpClient.fetch(`https://localhost:${server.port}`)
      expect(await response.json()).toEqual({ connected: true })
      if (route === 'SOCKS5') {
        expect(proxy.hosts).toEqual(new Set(['localhost']))
      } else {
        expect(proxy.requests).toEqual([`localhost:${server.port}`])
      }
    }
  )

  it('rejects a server signed by a different CA', async () => {
    const server = await endpoint()
    await applyProxySettingsToSession(
      session,
      { httpProxyCaCertificate: getCACertificates('default')[0] },
      { env: {} }
    )
    await expect(electronHttpClient.fetch(server.url)).rejects.toThrow(/certificate/i)
    expect(server.requests).toEqual([])
  })

  it('propagates caller cancellation to the response stream', async () => {
    const server = await endpoint()
    await applyProxySettingsToSession(
      session,
      { httpProxyCaCertificate: LOCAL_HTTPS_TEST_CERTIFICATE },
      { env: {} }
    )
    const controller = new AbortController()
    const response = await electronHttpClient.fetch(`${server.url}/stream`, {
      signal: controller.signal
    })
    const reader = response.body!.getReader()
    await reader.read()
    const reading = expect(reader.read()).rejects.toThrow()
    controller.abort()
    await reading
    await vi.waitFor(() => expect(server.streamClosed()).toBe(true))
  })

  it('preserves a replayable POST body across an allowed redirect', async () => {
    const server = await endpoint()
    await applyProxySettingsToSession(
      session,
      { httpProxyCaCertificate: LOCAL_HTTPS_TEST_CERTIFICATE },
      { env: {} }
    )
    const response = await electronHttpClient.fetch(`${server.url}/redirect307`, {
      method: 'POST',
      body: 'test payload',
      headers: { 'user-agent': 'caller-agent' }
    })
    const clone = response.clone()
    expect(clone.url).toBe(`${server.url}/secret-target`)
    expect(clone.redirected).toBe(true)
    expect(await response.json()).toEqual({ connected: true })
    expect(await clone.json()).toEqual({ connected: true })
    expect(server.requests.map(({ body, userAgent }) => ({ body, userAgent }))).toEqual([
      { body: 'test payload', userAgent: 'caller-agent' },
      { body: 'test payload', userAgent: 'caller-agent' }
    ])
  })

  it.each(['HEAD', '204'])('supports bodyless %s responses with custom trust', async (kind) => {
    const server = await endpoint()
    await applyProxySettingsToSession(
      session,
      {
        httpProxyCaCertificate: LOCAL_HTTPS_TEST_CERTIFICATE
      },
      { env: {} }
    )
    const response = await electronHttpClient.fetch(
      `${server.url}${kind === '204' ? '/empty' : '/'}`,
      {
        method: kind === 'HEAD' ? 'HEAD' : 'GET'
      }
    )
    expect(response.body).toBeNull()
    expect(await response.text()).toBe('')
  })

  it('allows cancelling an unread streaming response', async () => {
    const server = await endpoint()
    await applyProxySettingsToSession(
      session,
      {
        httpProxyCaCertificate: LOCAL_HTTPS_TEST_CERTIFICATE
      },
      { env: {} }
    )
    const response = await electronHttpClient.fetch(`${server.url}/stream`)
    await response.body!.cancel()
    await vi.waitFor(() => expect(server.streamClosed()).toBe(true))
  })

  it('closes in-flight HTTP streams when SSL bypass is revoked', async () => {
    const server = await endpoint()
    await applyProxySettingsToSession(
      session,
      { httpProxyIgnoreCertificateErrors: true },
      { env: {} }
    )
    const response = await electronHttpClient.fetch(`${server.url}/stream`)
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    const next = expect(reader.read()).rejects.toThrow()
    await applyProxySettingsToSession(
      session,
      { httpProxyIgnoreCertificateErrors: false },
      { env: {} }
    )
    await next
    await vi.waitFor(() => expect(server.streamClosed()).toBe(true))
    await expect(electronHttpClient.fetch(server.url)).rejects.toThrow()
  })

  it.each([
    { httpProxyCaCertificate: LOCAL_HTTPS_TEST_CERTIFICATE },
    { httpProxyIgnoreCertificateErrors: true }
  ])('applies the configured TLS policy to main HTTP requests: %j', async (settings) => {
    const server = await endpoint()
    await applyProxySettingsToSession(session, settings, { env: {} })
    const response = await electronHttpClient.fetch(server.url, {
      method: 'POST',
      headers: { authorization: 'Bearer test-only', 'content-type': 'application/json' },
      body: '{"code":"test-code"}'
    })
    expect(await response.json()).toEqual({ connected: true })
    expect(response.url).toBe(`${server.url}/`)
    expect(server.requests).toEqual([
      {
        url: '/',
        authorization: 'Bearer test-only',
        userAgent: 'Orca-test-Chromium',
        body: '{"code":"test-code"}'
      }
    ])
  })

  it('continues rejecting Cloud auth redirects with custom TLS trust', async () => {
    const server = await endpoint()
    await applyProxySettingsToSession(
      session,
      {
        httpProxyCaCertificate: LOCAL_HTTPS_TEST_CERTIFICATE
      },
      { env: {} }
    )
    await expect(
      electronHttpClient.fetch(`${server.url}/redirect`, {
        method: 'POST',
        body: 'test-code-verifier',
        redirect: 'error'
      })
    ).rejects.toThrow(/redirect/i)
    expect(server.requests.map((request) => request.url)).toEqual(['/redirect'])
  })

  it('keeps Chromium and strict certificate verification by default', async () => {
    const server = await endpoint()
    await applyProxySettingsToSession(session, {}, { env: {} })
    await expect(electronHttpClient.fetch(server.url)).rejects.toThrow()
    expect(chromiumFetch).toHaveBeenCalledOnce()
    expect(server.requests).toEqual([])
  })

  it('rejects malformed certificates before a request can be sent', async () => {
    const server = await endpoint()
    await expect(
      applyProxySettingsToSession(
        session,
        {
          httpProxyCaCertificate: 'not a certificate',
          httpProxyIgnoreCertificateErrors: true
        },
        { env: {} }
      )
    ).rejects.toThrow(/certificate/i)
    await expect(electronHttpClient.fetch(server.url)).rejects.toThrow()
    expect(server.requests).toEqual([])
  })
})
