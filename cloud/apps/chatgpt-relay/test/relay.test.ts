import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createRelay } from '../src/relay.ts'

type Seen = { url: string; headers: Headers; body: string | null }
let server: Server | null = null
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())))

async function start(reply: (seen: Seen) => Response) {
  const seen: Seen[] = []
  const logs: Record<string, unknown>[] = []
  const relay = createRelay({
    log: (line) => logs.push(line),
    fetch: async (input, init) => {
      const body = init?.body ? await new Response(init.body as BodyInit).text() : null
      const one = { url: String(input), headers: new Headers(init?.headers), body }
      seen.push(one)
      return reply(one)
    }
  })
  server = createServer((req, res) => void relay(req, res))
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string; chunks: string[] }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks: string[] = []
        res.setEncoding('utf8')
        res.on('data', (c: string) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: chunks.join(''), chunks }))
      })
      req.on('error', reject)
      req.end(body)
    })
  return { seen, logs, call }
}

describe('ChatGPT relay', () => {
  it('forwards an allowed Codex call to chatgpt.com with its credential, minus Cloud Run auth and hop headers', async () => {
    const t = await start(() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }))
    const res = await t.call(
      'POST',
      '/backend-api/codex/responses',
      {
        authorization: 'Bearer real-token',
        'chatgpt-account-id': 'acct-1',
        'x-serverless-authorization': 'Bearer google-id-token',
        'x-forwarded-for': '1.2.3.4',
        'content-type': 'application/json'
      },
      '{"input":"hi"}'
    )
    expect(res.status).toBe(200)
    expect(res.body).toBe('{"ok":true}')
    expect(res.headers['content-encoding']).toBeUndefined()
    const sent = t.seen[0]!
    expect(sent.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(sent.body).toBe('{"input":"hi"}')
    expect(sent.headers.get('authorization')).toBe('Bearer real-token')
    expect(sent.headers.get('chatgpt-account-id')).toBe('acct-1')
    expect(sent.headers.get('x-serverless-authorization')).toBeNull()
    expect(sent.headers.get('x-forwarded-for')).toBeNull()
    expect(sent.headers.get('host')).toBeNull()
  })

  it('pins the same paths as the Worker: nothing else on chatgpt.com', async () => {
    const t = await start(() => new Response('{}'))
    expect((await t.call('GET', '/backend-api/conversations')).status).toBe(403)
    expect((await t.call('POST', '/backend-api/wham/usage')).status).toBe(403)
    expect((await t.call('GET', '/backend-api/codex/../conversations')).status).toBe(403)
    expect((await t.call('GET', '/backend-api/wham/usage')).status).toBe(200)
    expect(t.seen.map((s) => s.url)).toEqual(['https://chatgpt.com/backend-api/wham/usage'])
  })

  it('streams Server-Sent Events as they arrive, not after the upstream ends', async () => {
    let push: (text: string) => void = () => {}
    let close: () => void = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text))
        close = () => controller.close()
      }
    })
    const t = await start(() => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const pending = t.call('POST', '/backend-api/codex/responses', { 'content-type': 'application/json' }, '{}')
    // The first event is out before the second exists.
    await new Promise((r) => setTimeout(r, 20))
    push('event: a\ndata: 1\n\n')
    await new Promise((r) => setTimeout(r, 50))
    push('event: b\ndata: 2\n\n')
    close()
    const res = await pending
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')
    expect(res.chunks.length).toBeGreaterThanOrEqual(2)
  })

  it('logs method, a two-segment path and the status only: never headers, bodies or queries', async () => {
    const t = await start(() => new Response('secret-body'))
    await t.call('GET', '/backend-api/codex/models?client_version=0.166.0', { authorization: 'Bearer real-token' })
    const text = JSON.stringify(t.logs)
    expect(t.logs.at(-1)).toMatchObject({ event: 'relay', method: 'GET', path: '/backend-api/codex', status: 200 })
    for (const leak of ['real-token', 'secret-body', 'client_version']) {
      expect(text).not.toContain(leak)
    }
  })

  it('refuses WebSocket upgrades and answers 502 when chatgpt.com is unreachable', async () => {
    const t = await start(() => {
      throw new TypeError('fetch failed')
    })
    expect((await t.call('GET', '/backend-api/codex/responses', { upgrade: 'websocket', connection: 'Upgrade' })).status).toBe(426)
    expect((await t.call('GET', '/backend-api/wham/usage')).status).toBe(502)
  })
})
