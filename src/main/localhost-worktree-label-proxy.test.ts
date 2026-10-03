import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalhostWorktreeLabelProxy } from './localhost-worktree-label-proxy'

const upstreamServers: http.Server[] = []

type ProxyRequestOptions = {
  method?: string
  headers?: http.OutgoingHttpHeaders
  body?: string
}

afterEach(async () => {
  await Promise.all(
    upstreamServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

async function startUpstream(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void
): Promise<number> {
  const server = http.createServer(handler)
  upstreamServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function fetchThroughProxy(
  labeledUrl: string,
  options: ProxyRequestOptions = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const url = new URL(labeledUrl)
  return new Promise((resolve, reject) => {
    // Why: *.orca.localhost is not resolvable DNS; connect to the proxy on
    // loopback and carry the label through the Host header instead.
    const request = http.request(
      {
        host: '127.0.0.1',
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: { ...options.headers, host: url.host }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers
          })
        )
      }
    )
    request.on('error', reject)
    request.end(options.body)
  })
}

describe('localhost worktree label proxy', () => {
  it('rejects https targets because the label proxy serves plain http', async () => {
    const proxy = new LocalhostWorktreeLabelProxy()

    await expect(
      proxy.registerRoute({
        targetUrl: 'https://localhost:5173/',
        projectName: 'Snap Studio',
        worktreeName: 'main'
      })
    ).rejects.toThrow('Only http workspace ports can be labeled.')
  })

  it('streams responses through untouched, preserving the app CSP and body', async () => {
    const port = await startUpstream((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'"
      })
      response.end('<html><head></head><body>hello</body></html>')
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'analytics'
    })

    const result = await fetchThroughProxy(url)

    expect(result.status).toBe(200)
    // The proxy only relabels the hostname; the page is delivered verbatim
    // with no injected favicon/title and the CSP header intact.
    expect(result.body).toBe('<html><head></head><body>hello</body></html>')
    expect(result.headers['content-security-policy']).toBe("default-src 'self'")
  })

  it('forwards the browser-facing host authoritatively on POST requests', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    const port = await startUpstream((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        upstreamRequest = {
          method: request.method,
          host: request.headers.host,
          forwardedHost: request.headers['x-forwarded-host'],
          origin: request.headers.origin,
          url: request.url,
          body: Buffer.concat(chunks).toString('utf8')
        }
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('ok')
      })
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'analytics'
    })
    const labeledUrl = new URL('/action', url)

    const result = await fetchThroughProxy(labeledUrl.toString(), {
      method: 'POST',
      headers: {
        origin: labeledUrl.origin,
        'x-forwarded-host': 'attacker.example'
      },
      body: 'action'
    })

    expect(upstreamRequest).toEqual({
      method: 'POST',
      host: `localhost:${port}`,
      forwardedHost: labeledUrl.host,
      origin: labeledUrl.origin,
      url: '/action',
      body: 'action'
    })
    expect(result.status).toBe(200)
    expect(result.body).toBe('ok')
  })

  it('normalizes a 0.0.0.0 target to a connectable loopback host', async () => {
    const port = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://0.0.0.0:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'main'
    })

    const result = await fetchThroughProxy(url)

    expect(result.status).toBe(200)
    expect(result.body).toBe('ok')
  })

  it('returns 404 for unregistered orca.localhost labels', async () => {
    const port = await startUpstream((_request, response) => {
      response.end('ok')
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'main'
    })
    const proxyPort = new URL(url).port

    const result = await fetchThroughProxy(`http://unknown-label.orca.localhost:${proxyPort}/`)

    expect(result.status).toBe(404)
  })

  it('drops a worktree label routes on unregisterWorktree, leaving others intact', async () => {
    const port = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const a = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'feature-a',
      worktreeId: 'wt-a'
    })
    const b = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'feature-b',
      worktreeId: 'wt-b'
    })

    expect((await fetchThroughProxy(a.url)).status).toBe(200)
    expect((await fetchThroughProxy(b.url)).status).toBe(200)

    proxy.unregisterWorktree('wt-a')

    // The removed worktree's label no longer routes; the other worktree is unaffected.
    expect((await fetchThroughProxy(a.url)).status).toBe(404)
    expect((await fetchThroughProxy(b.url)).status).toBe(200)
  })
})
