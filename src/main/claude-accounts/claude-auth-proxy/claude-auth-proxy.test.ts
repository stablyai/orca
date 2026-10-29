import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeAccountIdFromAuthProvenance, noteClaudeAuthSnapshot } from './claude-auth-proxy-host'
import {
  createClaudeAuthProxy,
  type ClaudeAuthProxy,
  type ClaudeAuthProxyOptions
} from './claude-auth-proxy'

const TOKEN_A = 'token-alpha-do-not-log'
const TOKEN_B = 'token-beta-do-not-log'

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('upstream did not bind')
  }
  return address.port
}

function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function proxyRequest(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string | Buffer
    timeoutMs?: number
  } = {}
): Promise<{ status: number; chunks: string[]; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const chunks: string[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, chunks, headers: res.headers }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (init.timeoutMs !== undefined) {
      req.setTimeout(init.timeoutMs, () => req.destroy(new Error('timeout')))
    }
    if (init.body !== undefined) {
      req.end(init.body)
    } else {
      req.end()
    }
  })
}

describe('claude auth proxy', () => {
  const proxies: ClaudeAuthProxy[] = []
  const upstreams: Server[] = []

  afterEach(async () => {
    await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()))
    await Promise.all(
      upstreams.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          })
      )
    )
  })

  async function started(
    readToken: (accountId: string) => Promise<string | null>,
    options: Pick<ClaudeAuthProxyOptions, 'now' | 'tokenTtlMs' | 'idleTimeoutMs'> = {}
  ) {
    const seen: { method?: string; url?: string; authorization?: string; body: string }[] = []
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const upstream = createServer(async (req, res) => {
      const body = await readBody(req)
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body
      })
      const forced = req.headers['x-status']
      if (typeof forced === 'string') {
        res.writeHead(Number(forced), {
          'content-type': 'application/json',
          'retry-after': '9'
        })
        res.end('{"error":"limited"}')
        return
      }
      if (req.headers['x-stream'] === '1') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: one\n\n')
        await gate
        res.end('data: two\n\n')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    upstreams.push(upstream)
    const port = await listen(upstream)
    const lines: string[] = []
    const proxy = createClaudeAuthProxy({
      ...options,
      readToken,
      upstream: `http://127.0.0.1:${port}`,
      log: (line) => {
        lines.push(line)
      }
    })
    proxies.push(proxy)
    await proxy.start()
    return { proxy, seen, lines, release }
  }

  it('replaces Authorization, forwards the request, and does not log the token', async () => {
    const readToken = vi.fn(async () => TOKEN_A)
    const { proxy, seen, lines } = await started(readToken)
    const slot = proxy.allocateSlot('account-a')
    const base = proxy.slotBaseUrl(slot)
    expect(base).toMatch(/\/p\/[0-9a-f]+\/$/)

    const response = await proxyRequest(`${base}v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer from-claude',
        'content-type': 'application/json',
        host: '127.0.0.1'
      },
      body: '{"hi":1}'
    })

    expect(response.status).toBe(200)
    expect(response.chunks.join('')).toBe('{"ok":true}')
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/v1/messages?beta=true',
        authorization: `Bearer ${TOKEN_A}`,
        body: '{"hi":1}'
      }
    ])
    expect(seen[0]?.authorization).not.toContain('from-claude')
    expect(readToken).toHaveBeenCalledTimes(1)
    expect(readToken).toHaveBeenCalledWith('account-a')
    expect(lines).toEqual(['POST /v1/messages 200 account-a'])
    expect(lines.join('\n')).not.toContain(TOKEN_A)
    expect(lines.join('\n')).not.toContain('beta=true')
  })

  it('streams an SSE response before the upstream finishes', async () => {
    const { proxy, release } = await started(async () => TOKEN_A)
    const slot = proxy.allocateSlot('account-a')
    const url = `${proxy.slotBaseUrl(slot)}v1/messages`
    const first = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('SSE chunk was buffered until the upstream ended')),
        1500
      )
      const req = httpRequest(url, { method: 'POST', headers: { 'x-stream': '1' } }, (res) => {
        res.once('data', (chunk: Buffer) => {
          clearTimeout(timer)
          resolve(chunk.toString('utf8'))
        })
        res.on('error', reject)
      })
      req.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      req.end('{}')
    })
    await expect(first).resolves.toBe('data: one\n\n')
    release()
  })

  it('keeps the incoming Authorization for an unknown slot and does not read a token', async () => {
    const readToken = vi.fn(async () => TOKEN_A)
    const { proxy, seen } = await started(readToken)
    const base = proxy.slotBaseUrl(proxy.allocateSlot('account-a'))
    const port = new URL(base!).port
    const response = await proxyRequest(`http://127.0.0.1:${port}/p/missing/v1/messages`, {
      headers: { authorization: 'Bearer from-claude' }
    })
    expect(response.status).toBe(200)
    expect(seen[0]?.authorization).toBe('Bearer from-claude')
    expect(readToken).not.toHaveBeenCalled()
  })

  it('keeps the incoming Authorization when the account has no token', async () => {
    const { proxy, seen } = await started(async () => null)
    const base = proxy.slotBaseUrl(proxy.allocateSlot('account-a'))
    await proxyRequest(`${base}v1/messages`, { headers: { authorization: 'Bearer from-claude' } })
    expect(seen[0]?.authorization).toBe('Bearer from-claude')
  })

  it('follows a slot flip on the next request', async () => {
    const tokens = [TOKEN_A, TOKEN_B]
    const readToken = vi.fn(async () => tokens.shift() ?? null)
    const { proxy, seen } = await started(readToken)
    const slot = proxy.allocateSlot('account-a')
    const base = proxy.slotBaseUrl(slot)
    await proxyRequest(`${base}v1/messages`)
    expect(proxy.assignSlot(slot, 'account-b')).toBe(true)
    expect(proxy.assignSlot('missing', 'account-b')).toBe(false)
    await proxyRequest(`${base}v1/messages`)
    expect(readToken).toHaveBeenCalledTimes(2)
    expect(seen.map((entry) => entry.authorization)).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_B}`
    ])
    expect(proxy.accountIdForSlot(slot)).toBe('account-b')
  })

  it('allocates a 128-bit slot and refuses a non-loopback bind', () => {
    expect(() =>
      createClaudeAuthProxy({ readToken: async () => null, bindHost: '0.0.0.0' })
    ).toThrow(/loopback/)
    expect(() =>
      createClaudeAuthProxy({ readToken: async () => null, bindHost: '192.168.1.9' })
    ).toThrow(/loopback/)
  })

  it('uses a 128-bit slot id and binds the published URL to loopback', async () => {
    const { proxy } = await started(async () => TOKEN_A)
    const slot = proxy.allocateSlot('account-a')
    const again = proxy.allocateSlot('account-a')
    expect(slot).toMatch(/^[0-9a-f]{32}$/)
    expect(again).toMatch(/^[0-9a-f]{32}$/)
    expect(again).not.toBe(slot)
    expect(proxy.slotBaseUrl(slot)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{32}\/$/)
    const status = proxy.status()
    expect(status.host).toBe('127.0.0.1')
    expect(status.listening).toBe(true)
    expect(status.slots).toEqual([
      { slot, accountId: 'account-a' },
      { slot: again, accountId: 'account-a' }
    ])
  })

  it('passes 429 and 503 through once and does not log the body or headers', async () => {
    const { proxy, seen, lines } = await started(async () => TOKEN_A)
    const base = proxy.slotBaseUrl(proxy.allocateSlot('account-a'))
    const limited = await proxyRequest(`${base}v1/messages`, {
      method: 'POST',
      headers: {
        'x-status': '429',
        'x-secret': 'HEADER_SENTINEL_9f3a',
        authorization: `Bearer ${TOKEN_A}`
      },
      body: 'BODY_SENTINEL_9f3a'
    })
    const unavailable = await proxyRequest(`${base}v1/messages`, {
      method: 'POST',
      headers: { 'x-status': '503' },
      body: 'BODY_SENTINEL_9f3a'
    })
    expect(limited.status).toBe(429)
    expect(limited.chunks.join('')).toBe('{"error":"limited"}')
    expect(limited.headers['retry-after']).toBe('9')
    expect(unavailable.status).toBe(503)
    expect(seen).toHaveLength(2)
    expect(lines).toEqual(['POST /v1/messages 429 account-a', 'POST /v1/messages 503 account-a'])
    const logged = lines.join('\n')
    expect(logged).not.toContain('BODY_SENTINEL_9f3a')
    expect(logged).not.toContain('HEADER_SENTINEL_9f3a')
    expect(logged).not.toContain(TOKEN_A)
    expect(proxy.status().lastError).toMatchObject({
      method: 'POST',
      path: '/v1/messages',
      status: 503,
      accountId: 'account-a'
    })
  })

  it('counts an unknown slot and forwards its own Authorization', async () => {
    const readToken = vi.fn(async () => TOKEN_A)
    const { proxy, seen, lines } = await started(readToken)
    const base = proxy.slotBaseUrl(proxy.allocateSlot('account-a'))
    const port = new URL(base!).port
    const response = await proxyRequest(`http://127.0.0.1:${port}/p/missing/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer from-claude', 'x-secret': 'HEADER_SENTINEL_9f3a' },
      body: 'BODY_SENTINEL_9f3a'
    })
    expect(response.status).toBe(200)
    expect(seen[0]?.authorization).toBe('Bearer from-claude')
    expect(seen[0]?.body).toBe('BODY_SENTINEL_9f3a')
    expect(readToken).not.toHaveBeenCalled()
    expect(proxy.status().unknownSlotRequests).toBe(1)
    expect(lines[0]).toBe('POST /v1/messages 200 -')
    expect(lines.join('\n')).not.toContain('BODY_SENTINEL_9f3a')
    expect(lines.join('\n')).not.toContain('HEADER_SENTINEL_9f3a')
    expect(lines.join('\n')).not.toContain('missing')
  })

  it('caches a token for 20s and drops it when that account is invalidated', async () => {
    let now = 1_000
    const readToken = vi.fn(async (accountId: string) =>
      accountId === 'account-a' ? TOKEN_A : TOKEN_B
    )
    const { proxy } = await started(readToken, { now: () => now, tokenTtlMs: 20_000 })
    const slotA = proxy.allocateSlot('account-a')
    const slotB = proxy.allocateSlot('account-b')
    await proxyRequest(`${proxy.slotBaseUrl(slotA)}v1/messages`)
    await proxyRequest(`${proxy.slotBaseUrl(slotA)}v1/messages`)
    expect(readToken).toHaveBeenCalledTimes(1)
    now += 19_999
    await proxyRequest(`${proxy.slotBaseUrl(slotA)}v1/messages`)
    expect(readToken).toHaveBeenCalledTimes(1)
    now += 1
    await proxyRequest(`${proxy.slotBaseUrl(slotA)}v1/messages`)
    expect(readToken).toHaveBeenCalledTimes(2)
    await proxyRequest(`${proxy.slotBaseUrl(slotB)}v1/messages`)
    expect(readToken).toHaveBeenCalledTimes(3)
    proxy.invalidateToken('account-a')
    await proxyRequest(`${proxy.slotBaseUrl(slotA)}v1/messages`)
    await proxyRequest(`${proxy.slotBaseUrl(slotB)}v1/messages`)
    expect(readToken).toHaveBeenCalledTimes(4)
    proxy.invalidateToken()
    await proxyRequest(`${proxy.slotBaseUrl(slotB)}v1/messages`)
    expect(readToken).toHaveBeenCalledTimes(5)
  })

  it('keeps the in-flight bearer when the slot flips mid-stream', async () => {
    const readToken = vi.fn(async (accountId: string) =>
      accountId === 'account-a' ? TOKEN_A : TOKEN_B
    )
    const { proxy, seen, release } = await started(readToken)
    const slot = proxy.allocateSlot('account-a')
    const url = `${proxy.slotBaseUrl(slot)}v1/messages`
    const first = new Promise<void>((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST', headers: { 'x-stream': '1' } }, (res) => {
        res.once('data', () => resolve())
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end('{}')
    })
    await first
    expect(proxy.assignSlot(slot, 'account-b')).toBe(true)
    release()
    await proxyRequest(url)
    expect(seen.map((entry) => entry.authorization)).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_B}`
    ])
    expect(seen).toHaveLength(2)
  })

  it('streams a 300 KB body before the client finishes sending it', async () => {
    let resolveFirst: (bytes: number) => void = () => {}
    const sawFirst = new Promise<number>((resolve) => {
      resolveFirst = resolve
    })
    let total = 0
    const upstream = createServer((req, res) => {
      req.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total >= 128 * 1024) {
          resolveFirst(total)
          resolveFirst = () => {}
        }
      })
      req.on('end', () => {
        res.writeHead(200)
        res.end(String(total))
      })
      req.on('error', () => res.destroy())
    })
    upstreams.push(upstream)
    const port = await listen(upstream)
    const proxy = createClaudeAuthProxy({
      readToken: async () => TOKEN_A,
      upstream: `http://127.0.0.1:${port}`
    })
    proxies.push(proxy)
    await proxy.start()
    const url = `${proxy.slotBaseUrl(proxy.allocateSlot('account-a'))}v1/messages`
    const firstHalf = Buffer.alloc(128 * 1024, 0x61)
    const rest = Buffer.alloc(300 * 1024 - firstHalf.length, 0x62)
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST' }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', reject)
      })
      req.on('error', reject)
      req.write(firstHalf)
      void sawFirst.then((bytes) => {
        expect(bytes).toBeGreaterThanOrEqual(firstHalf.length)
        req.end(rest)
      })
    })
    expect(response.status).toBe(200)
    expect(response.body).toBe(String(300 * 1024))
  })

  it('pauses an SSE upstream when the client does not read', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = Buffer.alloc(64 * 1024, 0x61)
      let writes = 0
      const timer = setInterval(() => {
        writes += 1
        const accepted = res.write(chunk)
        if (!accepted || writes > 40) {
          clearInterval(timer)
          settled({ accepted, writes })
          res.end()
        }
      }, 0)
      res.on('close', () => clearInterval(timer))
    })
    let settled: (result: { accepted: boolean; writes: number }) => void = () => {}
    const done = new Promise<{ accepted: boolean; writes: number }>((resolve) => {
      settled = resolve
    })
    upstreams.push(upstream)
    const port = await listen(upstream)
    const proxy = createClaudeAuthProxy({
      readToken: async () => TOKEN_A,
      upstream: `http://127.0.0.1:${port}`
    })
    proxies.push(proxy)
    await proxy.start()
    const url = `${proxy.slotBaseUrl(proxy.allocateSlot('account-a'))}v1/messages`
    const client = httpRequest(url, { method: 'POST' }, (res) => {
      res.pause()
    })
    client.on('error', () => {})
    client.end('{}')
    const result = await Promise.race([
      done,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('upstream never observed backpressure')), 2000)
      )
    ])
    client.destroy()
    expect(result.accepted).toBe(false)
    expect(result.writes).toBeLessThanOrEqual(40)
  })

  it('reuses one upstream connection for two requests', async () => {
    const sockets: Socket[] = []
    const upstream = createServer((req, res) => {
      if (req.socket) {
        sockets.push(req.socket)
      }
      res.writeHead(200)
      res.end('ok')
    })
    upstreams.push(upstream)
    const port = await listen(upstream)
    const proxy = createClaudeAuthProxy({
      readToken: async () => TOKEN_A,
      upstream: `http://127.0.0.1:${port}`
    })
    proxies.push(proxy)
    await proxy.start()
    const url = `${proxy.slotBaseUrl(proxy.allocateSlot('account-a'))}v1/messages`
    await proxyRequest(url)
    await proxyRequest(url)
    expect(sockets).toHaveLength(2)
    expect(sockets[0]).toBe(sockets[1])
  })

  it('returns one 502 when the upstream accepts and then drops the socket', async () => {
    let connections = 0
    const upstream = createServer((req) => {
      connections += 1
      req.socket?.destroy()
    })
    upstreams.push(upstream)
    const port = await listen(upstream)
    const lines: string[] = []
    const proxy = createClaudeAuthProxy({
      readToken: async () => TOKEN_A,
      upstream: `http://127.0.0.1:${port}`,
      log: (line) => lines.push(line)
    })
    proxies.push(proxy)
    await proxy.start()
    const response = await proxyRequest(
      `${proxy.slotBaseUrl(proxy.allocateSlot('account-a'))}v1/messages`
    )
    expect(response.status).toBe(502)
    expect(connections).toBe(1)
    expect(lines).toEqual(['GET /v1/messages 502 account-a'])
    expect(proxy.status().lastError?.status).toBe(502)
  })

  it('cuts an idle stream at the configured budget and keeps an active stream', async () => {
    const hanging = createServer(() => {})
    upstreams.push(hanging)
    const hangingPort = await listen(hanging)
    const idleProxy = createClaudeAuthProxy({
      readToken: async () => TOKEN_A,
      upstream: `http://127.0.0.1:${hangingPort}`,
      idleTimeoutMs: 200
    })
    proxies.push(idleProxy)
    await idleProxy.start()
    const idleStarted = Date.now()
    const idleOutcome = await proxyRequest(
      `${idleProxy.slotBaseUrl(idleProxy.allocateSlot('account-a'))}v1/messages`,
      { timeoutMs: 2000 }
    ).then(
      (response) => response.status,
      () => 'reset'
    )
    // The outgoing idle timer answers 502. The incoming socket timer can reset the client first.
    expect(idleOutcome === 502 || idleOutcome === 'reset').toBe(true)
    const idleElapsed = Date.now() - idleStarted
    expect(idleElapsed).toBeGreaterThan(150)
    expect(idleElapsed).toBeLessThan(1500)

    let writes = 0
    const activeUpstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const timer = setInterval(() => {
        writes += 1
        if (writes > 20) {
          clearInterval(timer)
          res.end()
          return
        }
        res.write('data: tick\n\n')
      }, 40)
      res.on('close', () => clearInterval(timer))
    })
    upstreams.push(activeUpstream)
    const activePort = await listen(activeUpstream)
    const activeProxy = createClaudeAuthProxy({
      readToken: async () => TOKEN_A,
      upstream: `http://127.0.0.1:${activePort}`,
      idleTimeoutMs: 200
    })
    proxies.push(activeProxy)
    await activeProxy.start()
    const chunks = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${activeProxy.slotBaseUrl(activeProxy.allocateSlot('account-a'))}v1/messages`,
        (res) => {
          let count = 0
          res.on('data', () => {
            count += 1
          })
          res.on('end', () => resolve(count))
          res.on('error', reject)
        }
      )
      req.on('error', reject)
      req.end()
    })
    expect(writes).toBeGreaterThan(10)
    expect(chunks).toBeGreaterThan(10)
  })

  it('finishes an in-flight stream on stop and refuses a new request', async () => {
    const { proxy, release } = await started(async () => TOKEN_A)
    const url = `${proxy.slotBaseUrl(proxy.allocateSlot('account-a'))}v1/messages`
    let sawFirst: () => void = () => {}
    const firstChunk = new Promise<void>((resolve) => {
      sawFirst = resolve
    })
    const body = new Promise<string>((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST', headers: { 'x-stream': '1' } }, (res) => {
        const chunks: string[] = []
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk.toString('utf8'))
          sawFirst()
        })
        res.on('end', () => resolve(chunks.join('')))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end('{}')
    })
    await firstChunk
    const startedAt = Date.now()
    const stopping = proxy.stop()
    await expect(proxyRequest(url, { timeoutMs: 500 })).rejects.toThrow()
    release()
    await stopping
    expect(Date.now() - startedAt).toBeLessThan(1000)
    await expect(body).resolves.toBe('data: one\n\ndata: two\n\n')
  })

  it('counts requests in the last hour and forgets older ones', async () => {
    let now = 0
    const { proxy } = await started(async () => TOKEN_A, { now: () => now })
    const url = `${proxy.slotBaseUrl(proxy.allocateSlot('account-a'))}v1/messages`
    await proxyRequest(url)
    now = 30 * 60 * 1000
    await proxyRequest(url)
    now = 61 * 60 * 1000
    await proxyRequest(`${proxy.slotBaseUrl(proxy.allocateSlot('account-b'))}v1/messages`)
    expect(proxy.status().requestsLastHour).toEqual([
      { accountId: 'account-a', count: 1 },
      { accountId: 'account-b', count: 1 }
    ])
  })

  it('invalidates the token cache only when the auth snapshot changes', () => {
    expect(claudeAccountIdFromAuthProvenance('profile:account-a')).toBe('account-a')
    expect(claudeAccountIdFromAuthProvenance('profile:account-a:wsl:Ubuntu')).toBe('account-a')
    expect(claudeAccountIdFromAuthProvenance('system')).toBeUndefined()
    expect(claudeAccountIdFromAuthProvenance('wsl:Ubuntu:system')).toBeUndefined()
    expect(claudeAccountIdFromAuthProvenance('profile:unavailable')).toBeUndefined()
    const same = { configDir: '/claude', provenance: 'profile:account-a' }
    expect(noteClaudeAuthSnapshot(same, same)).toBe(false)
    expect(
      noteClaudeAuthSnapshot(same, { configDir: '/other', provenance: 'profile:account-a' })
    ).toBe(true)
    expect(noteClaudeAuthSnapshot(null, { configDir: null, provenance: 'system' })).toBe(true)
  })
})
