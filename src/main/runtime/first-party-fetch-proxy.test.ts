import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy'
] as const

describe('first-party Node proxy routing', () => {
  const proxy = createServer()
  const direct = createServer((_request, response) => response.end('fixture-direct-ok'))
  let connectTarget: string | undefined
  const originalProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]))
  let proxyUrl: string
  let directUrl: string

  beforeAll(async () => {
    proxy.on('connect', (request, socket) => {
      connectTarget = request.url
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.once('data', () => {
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\nfixture-proxy-ok'
        )
      })
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const address = proxy.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected proxy fixture address')
    }
    proxyUrl = `http://127.0.0.1:${address.port}`
    await new Promise<void>((resolve) => direct.listen(0, '127.0.0.1', resolve))
    const directAddress = direct.address()
    if (!directAddress || typeof directAddress === 'string') {
      throw new Error('expected direct fixture address')
    }
    directUrl = `http://127.0.0.1:${directAddress.port}`
  })

  afterAll(async () => {
    for (const key of PROXY_ENV_KEYS) {
      const value = originalProxyEnv[key]
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve()))
    )
    await new Promise<void>((resolve, reject) =>
      direct.close((error) => (error ? reject(error) : resolve()))
    )
  })

  async function loadFirstPartyFetch() {
    vi.resetModules()
    return (await import('./first-party-fetch')).firstPartyFetch
  }

  function clearProxyEnvironment(): void {
    for (const key of PROXY_ENV_KEYS) {
      Reflect.deleteProperty(process.env, key)
    }
  }

  it('keeps Orca proxy precedence instead of Undici lowercase precedence', async () => {
    clearProxyEnvironment()
    process.env.HTTP_PROXY = proxyUrl
    process.env.http_proxy = 'socks4://127.0.0.1:9'
    process.env.NO_PROXY = ''
    const firstPartyFetch = await loadFirstPartyFetch()
    const url = 'http://unresolvable.invalid/orca'
    await expect(globalThis.fetch(url)).rejects.toThrow(/fetch failed/i)
    const response = await firstPartyFetch(url)
    await expect(response.text()).resolves.toBe('fixture-proxy-ok')
    expect(connectTarget).toBe('unresolvable.invalid:80')
  })

  it('preserves direct Node behavior for unsupported SOCKS environment proxies', async () => {
    clearProxyEnvironment()
    process.env.HTTP_PROXY = 'socks4://127.0.0.1:9'
    const firstPartyFetch = await loadFirstPartyFetch()
    const response = await firstPartyFetch(directUrl)
    await expect(response.text()).resolves.toBe('fixture-direct-ok')
  })
})
