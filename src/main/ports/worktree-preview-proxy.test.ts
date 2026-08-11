import http, { type Server } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreviewRouteEntry, PreviewRouteIndex } from './preview-route-resolver'
import { parsePreviewDomain } from './worktree-preview-routes'
import { WorktreePreviewProxy, type WorktreePreviewProxyOptions } from './worktree-preview-proxy'

const origin = parsePreviewDomain('http://preview.test')

type Harness = {
  port: number
  request: (options: {
    host: string
    path?: string
    headers?: Record<string, string>
  }) => Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>
  upgrade: (options: {
    host: string
    path?: string
    headers?: Record<string, string>
  }) => Promise<string>
}

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
  vi.restoreAllMocks()
})

async function startUpstream(
  handler: http.RequestListener = (request, response) => {
    response.writeHead(200, { 'x-upstream': 'yes' })
    response.end(`upstream:${request.headers.host}:${request.url}`)
  }
): Promise<number> {
  const server: Server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('upstream failed to bind')
  }
  return address.port
}

async function startUpgradeUpstream(
  onUpgrade: (request: http.IncomingMessage) => void
): Promise<number> {
  const server: Server = http.createServer()
  const sockets = new Set<Duplex>()
  server.on('upgrade', (request, socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    onUpgrade(request)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => {
    for (const socket of sockets) {
      socket.destroy()
    }
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('upgrade upstream failed to bind')
  }
  return address.port
}

function routeEntry(overrides: Partial<PreviewRouteEntry>): PreviewRouteEntry {
  return {
    worktreeId: 'repo::/w/feat',
    label: 'feat',
    displayName: 'feat',
    primaryPort: null,
    ports: [],
    ...overrides
  }
}

async function startProxy(
  index: PreviewRouteIndex,
  overrides: Partial<WorktreePreviewProxyOptions> = {}
): Promise<Harness> {
  const proxy = new WorktreePreviewProxy({
    bindHost: '127.0.0.1',
    port: 0,
    origin,
    auth: 'open',
    token: null,
    resolveRoutes: async () => index,
    ...overrides
  })
  const { port } = await proxy.start()
  cleanups.push(() => proxy.stop())
  return {
    port,
    request: ({ host, path = '/', headers = {} }) =>
      new Promise((resolve, reject) => {
        const request = http.request(
          { host: '127.0.0.1', port, path, headers: { host, ...headers } },
          (response) => {
            let body = ''
            response.on('data', (chunk: Buffer) => {
              body += chunk.toString()
            })
            response.on('end', () =>
              resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
            )
          }
        )
        request.once('error', reject)
        request.end()
      }),
    upgrade: ({ host, path = '/socket', headers = {} }) =>
      new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          const lines = [
            `GET ${path} HTTP/1.1`,
            `host: ${host}`,
            'connection: upgrade',
            'upgrade: websocket',
            ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
            '',
            ''
          ]
          socket.write(lines.join('\r\n'))
        })
        let raw = ''
        socket.setTimeout(2_000, () => {
          socket.destroy()
          reject(new Error('upgrade response timed out'))
        })
        socket.on('data', (chunk: Buffer) => {
          raw += chunk.toString()
          if (raw.includes('\r\n\r\n')) {
            socket.destroy()
            resolve(raw)
          }
        })
        socket.once('error', reject)
      })
  }
}

describe('WorktreePreviewProxy routing', () => {
  it('routes an explicit port suffix to the workspace listener', async () => {
    const upstreamPort = await startUpstream()
    const index: PreviewRouteIndex = new Map([
      ['feat', routeEntry({ ports: [{ port: upstreamPort, connectHost: 'localhost' }] })]
    ])
    const harness = await startProxy(index)

    const response = await harness.request({
      host: `feat--${upstreamPort}.preview.test`,
      path: '/api?x=1'
    })
    expect(response.status).toBe(200)
    expect(response.headers['x-upstream']).toBe('yes')
    // The upstream sees its own host, not the preview host.
    expect(response.body).toBe(`upstream:localhost:${upstreamPort}:/api?x=1`)
  })

  it('routes a bare label to the primary port', async () => {
    const upstreamPort = await startUpstream()
    const index: PreviewRouteIndex = new Map([
      [
        'feat',
        routeEntry({
          primaryPort: upstreamPort,
          ports: [{ port: upstreamPort, connectHost: 'localhost' }]
        })
      ]
    ])
    const harness = await startProxy(index)

    const response = await harness.request({ host: 'feat.preview.test' })
    expect(response.status).toBe(200)
  })

  it('lists ports when a bare label has several and none advertised', async () => {
    const index: PreviewRouteIndex = new Map([
      [
        'feat',
        routeEntry({
          ports: [
            { port: 3000, connectHost: 'localhost' },
            { port: 5173, connectHost: 'localhost' }
          ]
        })
      ]
    ])
    const harness = await startProxy(index)

    const response = await harness.request({ host: 'feat.preview.test' })
    expect(response.status).toBe(200)
    expect(response.body).toContain('feat--3000.preview.test')
    expect(response.body).toContain('feat--5173.preview.test')
  })

  it('404s unknown labels and hosts outside the preview domain', async () => {
    const harness = await startProxy(new Map())
    expect((await harness.request({ host: 'ghost.preview.test' })).status).toBe(404)
    expect((await harness.request({ host: 'other.example.com' })).status).toBe(404)
  })

  it('retries with a fresh scan before failing a port that just started', async () => {
    const upstreamPort = await startUpstream()
    const stale: PreviewRouteIndex = new Map([['feat', routeEntry({})]])
    const fresh: PreviewRouteIndex = new Map([
      ['feat', routeEntry({ ports: [{ port: upstreamPort, connectHost: 'localhost' }] })]
    ])
    const resolveRoutes = vi.fn(async ({ fresh: wantFresh = false } = {}) =>
      wantFresh ? fresh : stale
    )
    const harness = await startProxy(stale, { resolveRoutes })

    const response = await harness.request({ host: `feat--${upstreamPort}.preview.test` })
    expect(response.status).toBe(200)
    expect(resolveRoutes).toHaveBeenCalledWith({ fresh: true })
  })

  it('tears down the upstream request when the client disconnects', async () => {
    let markAccepted: (() => void) | null = null
    const accepted = new Promise<void>((resolve) => {
      markAccepted = resolve
    })
    let upstreamClosed = false
    const upstreamPort = await startUpstream((request) => {
      markAccepted?.()
      request.once('aborted', () => {
        upstreamClosed = true
      })
    })
    const harness = await startProxy(
      new Map([['feat', routeEntry({ ports: [{ port: upstreamPort, connectHost: 'localhost' }] })]])
    )
    const client = http.request({
      host: '127.0.0.1',
      port: harness.port,
      headers: { host: `feat--${upstreamPort}.preview.test` }
    })
    client.on('error', () => {})
    client.end()
    await accepted

    client.destroy()

    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
  })

  it('returns 502 when an upstream accepts but never responds', async () => {
    let markAccepted: (() => void) | null = null
    const accepted = new Promise<void>((resolve) => {
      markAccepted = resolve
    })
    const upstreamPort = await startUpstream(() => markAccepted?.())
    const harness = await startProxy(
      new Map([['feat', routeEntry({ ports: [{ port: upstreamPort, connectHost: 'localhost' }] })]])
    )
    vi.useFakeTimers()
    try {
      const response = harness.request({ host: `feat--${upstreamPort}.preview.test` })
      await accepted
      await vi.advanceTimersByTimeAsync(60_000)

      expect(await response).toMatchObject({ status: 502 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('WorktreePreviewProxy token auth', () => {
  async function startTokenProxy(upstreamPort: number): Promise<Harness> {
    const index: PreviewRouteIndex = new Map([
      ['feat', routeEntry({ ports: [{ port: upstreamPort, connectHost: 'localhost' }] })]
    ])
    return startProxy(index, { auth: 'token', token: 'secret' })
  }

  it('rejects requests without the token or cookie', async () => {
    const harness = await startTokenProxy(await startUpstream())
    const response = await harness.request({ host: 'feat--3000.preview.test' })
    expect(response.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const harness = await startTokenProxy(await startUpstream())
    const response = await harness.request({
      host: 'feat--3000.preview.test',
      path: '/?orca-preview-token=wrong'
    })
    expect(response.status).toBe(403)
  })

  it('exchanges a valid token query for a domain cookie and redirects', async () => {
    const upstreamPort = await startUpstream()
    const harness = await startTokenProxy(upstreamPort)
    const response = await harness.request({
      host: `feat--${upstreamPort}.preview.test`,
      path: '/deep/page?orca-preview-token=secret&keep=1'
    })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/deep/page?keep=1')
    const cookie = String(response.headers['set-cookie'])
    expect(cookie).toContain('orca_preview_token=secret')
    expect(cookie).toContain('Domain=preview.test')
    expect(cookie).toContain('HttpOnly')
  })

  it('pins the exchange redirect to root when the path smuggles a protocol-relative host', async () => {
    const harness = await startTokenProxy(await startUpstream())
    // WHATWG URL folds `\` into `/`, which would otherwise emit `Location: //evil.example`.
    const response = await harness.request({
      host: 'feat--3000.preview.test',
      path: '/\\evil.example?orca-preview-token=secret'
    })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/')
  })

  it('accepts the cookie on subsequent requests', async () => {
    const upstreamPort = await startUpstream()
    const harness = await startTokenProxy(upstreamPort)
    const response = await harness.request({
      host: `feat--${upstreamPort}.preview.test`,
      headers: { cookie: 'orca_preview_token=secret' }
    })
    expect(response.status).toBe(200)
  })

  it('never hands its own auth cookie to the workspace dev server', async () => {
    let seenCookie: string | undefined = 'unset'
    const upstreamPort = await startUpstream((request, response) => {
      seenCookie = request.headers.cookie
      response.writeHead(200)
      response.end('ok')
    })
    const harness = await startTokenProxy(upstreamPort)

    const response = await harness.request({
      host: `feat--${upstreamPort}.preview.test`,
      headers: { cookie: 'orca_preview_token=secret; app_session=keep-me' }
    })

    expect(response.status).toBe(200)
    // The dev server keeps its own cookies and never learns the proxy's token,
    // which gates every other workspace behind the same listener.
    expect(seenCookie).toBe('app_session=keep-me')
    expect(seenCookie).not.toContain('secret')
  })

  it('drops the cookie header entirely when the proxy token was its only value', async () => {
    let hadCookieHeader = true
    const upstreamPort = await startUpstream((request, response) => {
      hadCookieHeader = 'cookie' in request.headers
      response.writeHead(200)
      response.end('ok')
    })
    const harness = await startTokenProxy(upstreamPort)

    await harness.request({
      host: `feat--${upstreamPort}.preview.test`,
      headers: { cookie: 'orca_preview_token=secret' }
    })

    expect(hadCookieHeader).toBe(false)
  })

  it('forwards an authorized WebSocket upgrade without its auth cookie', async () => {
    let seenCookie: string | undefined
    const upstreamPort = await startUpgradeUpstream((request) => {
      seenCookie = request.headers.cookie
    })
    const harness = await startTokenProxy(upstreamPort)

    const response = await harness.upgrade({
      host: `feat--${upstreamPort}.preview.test`,
      headers: { cookie: 'orca_preview_token=secret; app_session=keep-me' }
    })

    expect(response).toMatch(/^HTTP\/1\.1 101 Switching Protocols/)
    expect(seenCookie).toBe('app_session=keep-me')
  })

  it('rejects a WebSocket upgrade without the auth cookie', async () => {
    let reachedUpstream = false
    const upstreamPort = await startUpgradeUpstream(() => {
      reachedUpstream = true
    })
    const harness = await startTokenProxy(upstreamPort)

    const response = await harness.upgrade({
      host: `feat--${upstreamPort}.preview.test`
    })

    expect(response).toMatch(/^HTTP\/1\.1 401 Unauthorized/)
    expect(reachedUpstream).toBe(false)
  })
})
