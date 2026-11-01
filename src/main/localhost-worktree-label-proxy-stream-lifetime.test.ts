import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalhostWorktreeLabelProxy } from './localhost-worktree-label-proxy'

const servers: http.Server[] = []
const requests: http.ClientRequest[] = []
const agents: http.Agent[] = []
const originalAgent = http.globalAgent

afterEach(async () => {
  vi.restoreAllMocks()
  for (const request of requests.splice(0)) {
    request.destroy()
  }
  for (const agent of agents.splice(0)) {
    agent.destroy()
  }
  http.globalAgent = originalAgent
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

async function startProxy(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void
): Promise<string> {
  const upstream = http.createServer(handler)
  servers.push(upstream)
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing upstream port')
  }
  const createServer = vi.spyOn(http, 'createServer')
  const proxy = new LocalhostWorktreeLabelProxy()
  const { url } = await proxy.registerRoute({
    targetUrl: `http://127.0.0.1:${address.port}/events?source=label`,
    projectName: 'Stream test',
    worktreeName: 'main'
  })
  const server = createServer.mock.results[0]?.value
  createServer.mockRestore()
  if (!(server instanceof http.Server)) {
    throw new Error('Missing proxy server')
  }
  servers.push(server)
  return url
}

function requestOptions(url: string): http.RequestOptions {
  const parsed = new URL(url)
  return {
    host: '127.0.0.1',
    port: Number(parsed.port),
    path: `${parsed.pathname}${parsed.search}`,
    headers: { host: parsed.host }
  }
}

describe('localhost label proxy response lifetime', () => {
  it('releases the upstream connection when cancelled before response headers', async () => {
    let enterUpstream = (): void => {}
    const entered = new Promise<void>((resolve) => {
      enterUpstream = resolve
    })
    let closed = false
    const url = await startProxy((_request, response) => {
      response.on('close', () => {
        closed = true
      })
      enterUpstream()
    })
    const request = http.get(requestOptions(url))
    requests.push(request)
    request.on('error', () => {})
    await entered
    request.destroy()

    await expect.poll(() => closed, { timeout: 1000 }).toBe(true)
  })

  it('releases every upstream stream after repeated downstream cancellation', async () => {
    let opened = 0
    let closed = 0
    const url = await startProxy((_request, response) => {
      opened += 1
      response.on('close', () => {
        closed += 1
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ready\n\n')
    })
    for (let index = 0; index < 16; index += 1) {
      await new Promise<void>((resolve, reject) => {
        const request = http.get(requestOptions(url), (response) => {
          response.once('data', () => response.destroy())
          response.once('close', resolve)
          response.on('error', reject)
        })
        requests.push(request)
        request.on('error', reject)
      })
    }

    expect(opened).toBe(16)
    await expect.poll(() => closed, { timeout: 1000 }).toBe(16)
  })

  it('forwards complete uploads and preserves successful upstream keepalive', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const downstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    agents.push(agent, downstreamAgent)
    http.globalAgent = agent
    const body = Buffer.alloc(64 * 1024, 'a')
    const sockets = new Set<http.IncomingMessage['socket']>()
    const url = await startProxy((request, response) => {
      sockets.add(request.socket)
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/events?source=label')
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        response.writeHead(201, { 'content-security-policy': "default-src 'self'" })
        response.end(Buffer.concat(chunks))
      })
    })
    for (let index = 0; index < 2; index += 1) {
      const result = await new Promise<Buffer>((resolve, reject) => {
        const request = http.request(
          { ...requestOptions(url), method: 'POST', agent: downstreamAgent },
          (response) => {
            expect(response.statusCode).toBe(201)
            expect(response.headers['content-security-policy']).toBe("default-src 'self'")
            const chunks: Buffer[] = []
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
            response.on('end', () => resolve(Buffer.concat(chunks)))
            response.on('error', reject)
          }
        )
        requests.push(request)
        request.on('error', reject)
        request.write(body.subarray(0, body.length / 2))
        request.end(body.subarray(body.length / 2))
      })
      expect(result).toEqual(body)
    }
    expect(sockets.size).toBe(1)
    for (const socket of sockets) {
      expect(socket.destroyed).toBe(false)
    }
  })
})
