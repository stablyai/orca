import { afterEach, describe, expect, it, vi } from 'vitest'
import { INGRESS_HEADER } from '../../../packages/relay-contract/src/ingress-header'
import type { Env } from '../src/env'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  }
}))
const { default: worker } = await import('../src/index')
const { HOLD_PING_MS, HOLD_SILENCE_CODE, HOLD_SILENCE_MS } = await import('../src/hold-probe')

// The Workers runtime's WebSocketPair and 101 responses, which Node lacks.
class FakeSocket extends EventTarget {
  sent: string[] = []
  closed: number | undefined
  accept() {}
  send(data: string) { this.sent.push(data) }
  close(code?: number) { this.closed = code }
}
let servers: FakeSocket[] = []
vi.stubGlobal('WebSocketPair', class {
  0 = new FakeSocket()
  1 = new FakeSocket()
  constructor() { servers.push(this[1]) }
})
vi.stubGlobal('Response', class extends Response {
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    const upgrade = init?.status === 101
    super(body, upgrade ? { ...init, status: 200 } : init)
    if (upgrade) { Object.defineProperty(this, 'status', { value: 101 }) }
  }
})

const TOKEN = 't'.repeat(40)
const SID = 'AbCd1234efGH'

function harness(extra: Partial<Env> = {}) {
  // Metrics as [event, label, reason, sessionId, value].
  const metrics: unknown[][] = []
  const env = {
    EDGE_BACKEND: 'spike',
    SPIKE_DEBUG: '1',
    RELAY_JWKS: '{"keys":[]}',
    RELAY_JWT_AUDIENCE: 'orca-relay',
    PING_INTERVAL_MS: '30000',
    SILENCE_TIMEOUT_MS: '75000',
    ORPHAN_GRACE_MS: '30000',
    INGRESS_TOKENS: TOKEN,
    INGRESS_ORIGINS: 'https://cn.relay.example',
    INGRESS_SOURCE_CIDRS: '34.96.0.0/20',
    METRICS: { writeDataPoint: ({ blobs, doubles }: { blobs: string[]; doubles: number[] }) => metrics.push([blobs[0], blobs[1], blobs[3], blobs[5], doubles[0]]) },
    ...extra
  } as unknown as Env
  const get = (path: string, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`https://edge.relay.example${path}`, { headers: { 'cf-connecting-ip': '203.0.113.1', ...headers } }), env)
  return { get, metrics }
}
const ws = { upgrade: 'websocket' }
const front = { ...ws, [INGRESS_HEADER]: `v1s cn https://cn.relay.example ${TOKEN}`, 'cf-connecting-ip': '34.96.3.9', 'x-orca-client-ip': '198.51.100.7', 'x-orca-client-country': 'CN' }

afterEach(() => {
  servers = []
  vi.useRealTimers()
})

describe('hold probe', () => {
  it('is 404 on every probe path unless HOLD_PROBE is 1', async () => {
    for (const flag of [undefined, '0', 'true']) {
      const h = harness(flag === undefined ? {} : { HOLD_PROBE: flag })
      for (const path of ['/__probe/page', `/__probe/hold/${SID}`, '/__probe/hold/x']) {
        expect((await h.get(path, ws)).status).toBe(404)
      }
      expect(h.metrics).toEqual([])
    }
  })

  it('serves the page with both targets, and validates the session id', async () => {
    const h = harness({ HOLD_PROBE: '1' })
    const page = await h.get('/__probe/page')
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('[["front","wss://cn.relay.example"],["direct","wss://edge.relay.example"]]')
    expect(html).toContain('请保持此页面打开')
    for (const bad of ['short', 'a'.repeat(33), 'abc_defgh12', 'abcdefgh/x']) {
      expect((await h.get(`/__probe/hold/${bad}`, ws)).status).toBe(bad.includes('/') ? 404 : 400)
    }
    expect((await h.get(`/__probe/hold/${SID}`)).status).toBe(426)
    expect(servers).toEqual([])
  })

  it('labels the path front only for a trusted front door hop, and writes the close with age and code', async () => {
    vi.useFakeTimers()
    const h = harness({ HOLD_PROBE: '1' })
    expect((await h.get(`/__probe/hold/${SID}`, front)).status).toBe(101)
    expect((await h.get(`/__probe/hold/${SID}`, ws)).status).toBe(101)
    // From the front door ranges with a wrong token: refused, as every route is.
    expect((await h.get(`/__probe/hold/${SID}`, { ...front, [INGRESS_HEADER]: `v1s cn https://cn.relay.example ${'x'.repeat(40)}` })).status).toBe(403)
    const [viaFront, direct] = servers as [FakeSocket, FakeSocket]
    vi.advanceTimersByTime(HOLD_PING_MS)
    expect(viaFront.sent).toEqual(['p:1'])
    viaFront.dispatchEvent(Object.assign(new Event('message'), { data: 'c:3600:1006' }))
    vi.advanceTimersByTime(HOLD_PING_MS)
    viaFront.dispatchEvent(Object.assign(new Event('close'), { code: 1006 }))
    viaFront.dispatchEvent(Object.assign(new Event('close'), { code: 1006 }))
    expect(h.metrics).toEqual([
      ['hold_open', 'front', '', SID, 1],
      ['hold_open', 'direct', '', SID, 1],
      ['ingress_rejected', '', '', undefined, 1],
      ['hold_client_close', 'front', '1006', SID, 3600],
      ['hold_close', 'front', '1006', SID, 50]
    ])
    // The direct socket never echoes: closed for silence, once.
    h.metrics.length = 0
    vi.advanceTimersByTime(HOLD_SILENCE_MS)
    expect(direct.closed).toBe(HOLD_SILENCE_CODE)
    direct.dispatchEvent(Object.assign(new Event('close'), { code: HOLD_SILENCE_CODE }))
    expect(h.metrics).toEqual([['hold_close', 'direct', String(HOLD_SILENCE_CODE), SID, 100]])
  })
})
