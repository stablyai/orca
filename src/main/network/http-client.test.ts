import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer as createHttpServer, type Server } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { setDefaultProxySessionResolver } from './electron-default-proxy-session'
import { fetchWithConfiguredProxy, getMainHttpClient, setMainHttpClient } from './http-client'

/** A CONNECT proxy that records its targets and tunnels every tunnel to the test origin. */
function startConnectProxy(
  originPort: number
): Promise<{ server: Server; port: number; targets: string[] }> {
  const targets: string[] = []
  const server = createHttpServer()
  server.on('connect', (request, clientSocket, head) => {
    targets.push(request.url ?? '')
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const upstream = connectSocket(originPort, '127.0.0.1', () => {
      upstream.write(head)
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    clientSocket.on('error', () => upstream.destroy())
    upstream.on('error', () => clientSocket.destroy())
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'string' || address === null) {
        throw new Error('expected TCP proxy')
      }
      resolve({ server, port: address.port, targets })
    })
  })
}

function startOrigin(body: string): Promise<{ server: Server; port: number }> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'string' || address === null) {
        throw new Error('expected TCP origin')
      }
      resolve({ server, port: address.port })
    })
  })
}

describe('main HTTP client proxy fallback', () => {
  const servers: Server[] = []

  afterEach(async () => {
    setMainHttpClient(null)
    setDefaultProxySessionResolver(null)
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    )
  })

  it('tunnels a Node-host request through the resolved proxy', async () => {
    const origin = await startOrigin('through the proxy')
    servers.push(origin.server)
    const proxy = await startConnectProxy(origin.port)
    servers.push(proxy.server)
    setDefaultProxySessionResolver(() => ({
      resolveProxy: async () => `PROXY 127.0.0.1:${proxy.port}`,
      setProxy: async () => {}
    }))

    // The proxy agent only reaches Node's global fetch as a per-request dispatcher, which is
    // the seam a runtime undici change could silently break.
    const response = await getMainHttpClient().fetch('http://origin.invalid/tunnelled')

    await expect(response.text()).resolves.toBe('through the proxy')
    expect(proxy.targets).toEqual(['origin.invalid:80'])
  })

  it('leaves a direct target on the direct path', async () => {
    const origin = await startOrigin('direct')
    servers.push(origin.server)
    const proxy = await startConnectProxy(origin.port)
    servers.push(proxy.server)
    setDefaultProxySessionResolver(() => ({
      resolveProxy: async () => 'DIRECT',
      setProxy: async () => {}
    }))

    const response = await getMainHttpClient().fetch(`http://127.0.0.1:${origin.port}/direct`)

    await expect(response.text()).resolves.toBe('direct')
    expect(proxy.targets).toEqual([])
  })

  it('keeps the default client usable without a proxy session', async () => {
    const origin = await startOrigin('no session')
    servers.push(origin.server)

    const response = await getMainHttpClient().fetch(`http://127.0.0.1:${origin.port}/any`)

    await expect(response.text()).resolves.toBe('no session')
  })

  it('forwards a Request input and probes its URL for the proxy', async () => {
    const resolveProxy = vi.fn(async () => 'DIRECT')
    setDefaultProxySessionResolver(() => ({ resolveProxy, setProxy: async () => {} }))
    const recorded: RequestInfo[] = []
    setMainHttpClient({
      fetch: async (input) => {
        recorded.push(input)
        return Response.json({ forwarded: true })
      },
      proxySession: () => null
    })

    const request = new Request('https://relay.example/v1/assign', {
      method: 'POST',
      body: 'payload'
    })
    const response = await fetchWithConfiguredProxy(request)

    // The request keeps its own method and body; only its URL chooses the proxy.
    expect(recorded).toEqual([request])
    expect(resolveProxy).toHaveBeenCalledWith('https://relay.example/v1/assign')
    await expect(response.json()).resolves.toEqual({ forwarded: true })
  })
})
