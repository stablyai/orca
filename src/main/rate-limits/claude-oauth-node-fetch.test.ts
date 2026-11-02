import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { gzipSync } from 'node:zlib'
import { expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => {
  const state: { session: object | null; fetch: ReturnType<typeof vi.fn> } = {
    session: null,
    fetch: vi.fn(async () => new Response('from-client', { status: 599 }))
  }
  return state
})

vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({
    fetch: transport.fetch,
    proxySession: () => transport.session
  })
}))

import {
  CLAUDE_OAUTH_TOKEN_HEADERS,
  claudeOAuthTokenFetch,
  nodeHttpFetch,
  type NodeHttpRequest
} from './claude-oauth-node-fetch'

const httpTokenRequest: NodeHttpRequest = (url, options, callback) =>
  httpRequest(url, options, callback)

async function withServer(
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
  run: (origin: string) => Promise<void>
): Promise<void> {
  const server = createServer(onRequest)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('test server has no port')
  }
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

it('decodes a gzip token response and sends the axios header set without cookies', async () => {
  const payload = JSON.stringify({ error: 'rate_limit_error' })
  const gzip = gzipSync(Buffer.from(payload))
  const seen: IncomingMessage['headers'][] = []
  let hits = 0
  await withServer(
    (req, res) => {
      hits += 1
      seen.push(req.headers)
      res.writeHead(429, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'retry-after': '15',
        connection: 'close'
      })
      res.end(gzip)
    },
    async (origin) => {
      const response = await nodeHttpFetch(httpTokenRequest, `${origin}/token`, {
        method: 'POST',
        headers: { ...CLAUDE_OAUTH_TOKEN_HEADERS, Cookie: 'session=do-not-send' },
        body: '{"ping":true}'
      })
      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBe('15')
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(await response.json()).toEqual({ error: 'rate_limit_error' })
    }
  )
  expect(hits).toBe(1)
  const headers = seen[0]
  expect(headers?.['user-agent']).toBe('axios/1.15.2')
  expect(headers?.accept).toBe(CLAUDE_OAUTH_TOKEN_HEADERS.Accept)
  expect(headers?.['accept-encoding']).toBe(CLAUDE_OAUTH_TOKEN_HEADERS['Accept-Encoding'])
  expect(headers?.['content-type']).toBe('application/json')
  expect(headers?.['content-length']).toBe(String(Buffer.byteLength('{"ping":true}')))
  expect(headers?.cookie).toBeUndefined()
})

it('returns a redirect instead of replaying the body', async () => {
  let hits = 0
  await withServer(
    (req, res) => {
      hits += 1
      if (req.url === '/next') {
        res.writeHead(200, { connection: 'close' })
        res.end('followed')
        return
      }
      res.writeHead(302, { location: '/next', connection: 'close' })
      res.end('stay')
    },
    async (origin) => {
      const response = await nodeHttpFetch(httpTokenRequest, `${origin}/start`, {
        method: 'POST',
        headers: { ...CLAUDE_OAUTH_TOKEN_HEADERS },
        body: '{"ping":true}'
      })
      expect(response.status).toBe(302)
      expect(await response.text()).toBe('stay')
    }
  )
  expect(hits).toBe(1)
})

it('rejects a corrupt gzip body instead of leaving the error unhandled', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(429, { 'content-encoding': 'gzip', connection: 'close' })
      res.end(Buffer.from('not-gzip'))
    },
    async (origin) => {
      await expect(
        nodeHttpFetch(httpTokenRequest, `${origin}/token`, {
          method: 'POST',
          headers: { ...CLAUDE_OAUTH_TOKEN_HEADERS },
          body: '{}'
        })
      ).rejects.toThrow()
    }
  )
})

it('uses node http when the installed client owns a session', async () => {
  transport.session = { installed: true }
  transport.fetch.mockClear()
  try {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { connection: 'close' })
        res.end('ok')
      },
      async (origin) => {
        const response = await claudeOAuthTokenFetch(`${origin}/token`, {
          method: 'POST',
          body: '{}'
        })
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('ok')
      }
    )
    expect(transport.fetch).not.toHaveBeenCalled()
  } finally {
    transport.session = null
  }
})

it('keeps an injected client that has no session', async () => {
  transport.session = null
  transport.fetch.mockClear()
  const response = await claudeOAuthTokenFetch('https://example.test/token', {
    method: 'POST',
    body: '{}'
  })
  expect(response.status).toBe(599)
  expect(transport.fetch).toHaveBeenCalledOnce()
})

it('rejects an already aborted request before connecting', async () => {
  await expect(
    nodeHttpFetch(httpTokenRequest, 'http://127.0.0.1:9/', {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.abort()
    })
  ).rejects.toThrow(/aborted/)
})
