import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { createServer, request, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { INGRESS_HEADER, verifyIngressHeader } from '@orca-cloud/relay-contract/ingress-header'
import { createIngressProxy } from './proxy.js'

const SECRET = 's'.repeat(40)
const ORIGIN = 'https://cn.relay.example'
const dir = mkdtempSync(join(tmpdir(), 'relay-ingress-test-'))
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
const tls = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }

const seen: { headers: IncomingHttpHeaders[]; closes: number[] } = { headers: [], closes: [] }
const events: Record<string, unknown>[] = []
let upstream: Server
let proxy: ReturnType<typeof createIngressProxy>
let base = ''

function listen(server: { listen: (port: number, host: string, cb: () => void) => unknown; address: () => unknown }): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

beforeAll(async () => {
  // Stands in for the edge Worker: echoes frames, closes on request, refuses unauthenticated upgrades.
  upstream = createServer(tls, (req, res) => {
    seen.headers.push(req.headers)
    res.writeHead(200, { 'content-type': 'text/plain' }).end('edge says hi')
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  upstream.on('upgrade', (req, socket, head) => {
    seen.headers.push(req.headers)
    if (!req.headers.authorization) return void socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n')
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, binary) => (data.toString() === 'close-me' ? ws.close(4409, 'host not on this cell') : ws.send(data, { binary })))
      ws.on('close', (code) => seen.closes.push(code))
    })
  })
  const port = await listen(upstream)
  proxy = createIngressProxy({
    name: 'cn',
    publicOrigin: ORIGIN,
    upstream: new URL(`https://127.0.0.1:${port}`),
    upstreamCa: tls.cert,
    secret: SECRET,
    tls,
    idleTimeoutMs: 300_000,
    drainDelayMs: 50,
    drainMs: 400,
    log: (event) => events.push(event)
  })
  base = `https://localhost:${await listen(proxy.server)}`
  await listen(proxy.health)
})

afterAll(() => {
  upstream.close()
  rmSync(dir, { recursive: true, force: true })
})

function call(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request(`${base}${path}`, { method, ca: tls.cert, headers }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject).end()
  })
}

const open = (path: string, headers: Record<string, string>) => {
  const ws = new WebSocket(`${base.replace('https', 'wss')}${path}`, { ca: tls.cert, headers, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 })
  ws.on('error', () => {})
  return ws
}

describe('ingress proxy', () => {
  it('forwards plain requests with a signed header and strips anything a client could forge', async () => {
    const forged = { [INGRESS_HEADER]: 'v1 cn https://evil.example 1.2.3.4 0 x', 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4', 'x-edge-origin': 'https://evil.example' }
    const response = await call('GET', '/health', forged)
    expect(response).toEqual({ status: 200, body: 'edge says hi' })
    const headers = seen.headers.at(-1)!
    expect(headers.host).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(headers['cf-connecting-ip']).toBeUndefined()
    expect(headers['x-forwarded-for']).toBeUndefined()
    expect(headers['x-edge-origin']).toBeUndefined()
    expect(await verifyIngressHeader(headers[INGRESS_HEADER] as string, [SECRET])).toEqual({ name: 'cn', origin: ORIGIN, clientIp: '127.0.0.1' })
  })

  it('answers 404 itself for anything outside /v1 and /health (admin and spike routes never reach the edge)', async () => {
    const before = seen.headers.length
    const { status } = await call('POST', '/__admin/assign')
    const ws = open('/__spike/abort/x', { authorization: 'Bearer t' })
    const refused = await new Promise<number>((r) => ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0)))
    expect(refused).toBe(404)
    expect(status).toBe(404)
    expect(seen.headers.length).toBe(before)
  })

  it('pipes WebSocket frames (4 MiB) and close codes both ways, unchanged', async () => {
    const ws = open('/v1/host/control', { authorization: 'Bearer token-value' })
    await new Promise((r) => ws.once('open', r))
    expect(seen.headers.at(-1)!.authorization).toBe('Bearer token-value')
    const big = Buffer.alloc(4 * 1024 * 1024, 7)
    ws.send(big)
    const echoed = await new Promise<Buffer>((r) => ws.once('message', (d) => r(d as Buffer)))
    expect(echoed.equals(big)).toBe(true)
    ws.send('close-me')
    const [code, reason] = await new Promise<[number, string]>((r) => ws.once('close', (c, why) => r([c, why.toString()])))
    expect([code, reason]).toEqual([4409, 'host not on this cell'])

    const mine = open('/v1/connect/AbCdEfGhIjKlMnOp', { authorization: 'Bearer x' })
    await new Promise((r) => mine.once('open', r))
    mine.close(4001, 'bye')
    await new Promise((r) => mine.once('close', r))
    await expect.poll(() => seen.closes.at(-1)).toBe(4001)
  })

  it("passes the edge's refusal of an upgrade through as-is", async () => {
    const ws = open('/v1/host/control', {})
    expect(await new Promise<number>((r) => ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0)))).toBe(401)
  })

  it('drains: health fails, open tunnels are cut after the drain window, logs carry no address, path or token', async () => {
    const ws = open('/v1/host/control', { authorization: 'Bearer secret-token' })
    await new Promise((r) => ws.once('open', r))
    const healthUrl = `http://127.0.0.1:${(proxy.health.address() as AddressInfo).port}/healthz`
    expect((await fetch(healthUrl)).status).toBe(200)
    const started = Date.now()
    const drained = proxy.drain()
    expect((await fetch(healthUrl)).status).toBe(503)
    const code = await new Promise<number>((r) => ws.once('close', (c) => r(c)))
    await drained
    expect(code).toBe(1006)
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    expect(events.map((e) => e.event)).toEqual(['drain_start', 'drain_done'])
    expect(events.at(-1)).toMatchObject({ cut: 1 })
    expect(proxy.stats.upgrades).toMatchObject({ 'control:101': 2, 'control:401': 1, 'connect:101': 1 })
    const logged = JSON.stringify([events, proxy.stats])
    for (const leak of ['127.0.0.1', '/v1/', 'Bearer', 'AbCdEfGhIjKlMnOp', 'secret-token']) expect(logged).not.toContain(leak)
  })
})
