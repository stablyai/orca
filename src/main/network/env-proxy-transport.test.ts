import { createServer, type Server } from 'node:http'
import {
  createServer as createTcpServer,
  connect,
  type AddressInfo,
  type Server as TcpServer
} from 'node:net'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  accountRelayFetch,
  createEnvProxyFetch,
  envProxyWsAgent,
  envProxyWsOptions
} from './env-proxy-transport'

function portOf(listening: { address(): string | AddressInfo | null }): number {
  const address = listening.address()
  if (!address || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port')
  }
  return address.port
}

describe('envProxyWsAgent', () => {
  it('returns nothing without a proxy so ws keeps its default agent', () => {
    expect(envProxyWsAgent('wss://relay.onorca.dev/v1/host/control', {})).toBeUndefined()
    expect(envProxyWsOptions('wss://relay.onorca.dev/v1/host/control', {})).toEqual({})
  })

  it('uses a CONNECT agent for http and https proxies', () => {
    const env = { HTTPS_PROXY: 'http://proxy.corp:8080' }
    expect(envProxyWsAgent('wss://relay.onorca.dev/x', env)).toBeInstanceOf(HttpsProxyAgent)
  })

  it.each(['socks5', 'socks5h', 'socks4'])('uses a SOCKS agent for %s', (scheme) => {
    const env = { ALL_PROXY: `${scheme}://127.0.0.1:1080` }
    expect(envProxyWsAgent('wss://relay.onorca.dev/x', env)).toBeInstanceOf(SocksProxyAgent)
  })

  it('honors NO_PROXY', () => {
    const env = { ALL_PROXY: 'socks5://127.0.0.1:1080', NO_PROXY: '.onorca.dev' }
    expect(envProxyWsOptions('wss://relay.onorca.dev/x', env)).toEqual({})
  })
})

describe('createEnvProxyFetch', () => {
  let server: Server | null = null
  afterEach(() => {
    server?.close()
    server = null
    vi.restoreAllMocks()
  })

  it('is null when no proxy variable exists, so the global fetch stays in use', () => {
    expect(createEnvProxyFetch({})).toBeNull()
    expect(accountRelayFetch()).toBe(globalThis.fetch)
  })

  it('sends a plain-http request through the configured HTTP proxy', async () => {
    const seen: string[] = []
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.host}`)
      res.end('ok')
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = portOf(server)
    const proxied = createEnvProxyFetch({ HTTP_PROXY: `http://127.0.0.1:${port}` })!

    const response = await proxied('http://upstream.invalid/path')

    expect(await response.text()).toBe('ok')
    expect(seen).toEqual(['GET http://upstream.invalid/path upstream.invalid'])
  })

  it('goes direct for NO_PROXY hosts', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('direct'))
    const proxied = createEnvProxyFetch({
      HTTPS_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: 'login.onorca.dev'
    })!

    await proxied('https://login.onorca.dev/v1')

    expect(globalFetch).toHaveBeenCalledTimes(1)
  })

  it('tunnels through a SOCKS5 proxy and sends the hostname to it unresolved', async () => {
    server = createServer((_req, res) => res.end('via-socks'))
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const upstreamPort = portOf(server)
    const requestedHosts: string[] = []
    const socks: TcpServer = createTcpServer((client) => {
      client.once('data', () => {
        client.write(Buffer.from([5, 0]))
        client.once('data', (request) => {
          requestedHosts.push(request.subarray(5, 5 + request[4]).toString())
          const upstream = connect(upstreamPort, '127.0.0.1', () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
            client.pipe(upstream)
            upstream.pipe(client)
          })
          upstream.on('error', () => client.destroy())
          client.on('error', () => upstream.destroy())
        })
      })
    })
    await new Promise<void>((resolve) => socks.listen(0, '127.0.0.1', resolve))
    try {
      const proxied = createEnvProxyFetch({
        ALL_PROXY: `socks5://127.0.0.1:${portOf(socks)}`
      })!

      const response = await proxied(`http://relay.example.test:${upstreamPort}/`)

      expect(await response.text()).toBe('via-socks')
      expect(requestedHosts).toEqual(['relay.example.test'])
    } finally {
      socks.close()
    }
  })
})
