import { describe, expect, it, vi } from 'vitest'
import { INGRESS_HEADER, signIngressHeader, verifyIngressHeader } from '../../../packages/relay-contract/src/ingress-header'
import type { Env } from '../src/env'
import { inCidrs, parseCidr, parseIp } from '../src/ingress'
import { requestPlace } from '../src/metrics'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  }
}))
const { default: worker, HostRelay } = await import('../src/index')
const { edgeConfig } = await import('../src/env')

const SECRET = 'a'.repeat(40)
const OLD_SECRET = 'b'.repeat(40)
const CLAIM = { name: 'cn', origin: 'https://cn.relay.example', clientIp: '198.51.100.7' }
const HOST = 'AbCdEfGhIjKlMnOp'

describe('ingress header', () => {
  it('round-trips, and accepts a secret being rotated out', async () => {
    expect(await verifyIngressHeader(await signIngressHeader(SECRET, CLAIM), [SECRET])).toEqual(CLAIM)
    expect(await verifyIngressHeader(await signIngressHeader(OLD_SECRET, CLAIM), [SECRET, OLD_SECRET])).toEqual(CLAIM)
  })

  it('refuses a wrong secret, any edited field, skew past the window, and junk', async () => {
    const now = 1_800_000_000_000
    const header = await signIngressHeader(SECRET, CLAIM, now)
    expect(await verifyIngressHeader(header, [OLD_SECRET], now)).toBeNull()
    expect(await verifyIngressHeader(header, [], now)).toBeNull()
    expect(await verifyIngressHeader(header.replace('198.51.100.7', '198.51.100.8'), [SECRET], now)).toBeNull()
    expect(await verifyIngressHeader(header.replace('https://cn.', 'https://xx.'), [SECRET], now)).toBeNull()
    expect(await verifyIngressHeader(header, [SECRET], now + 121_000)).toBeNull()
    expect(await verifyIngressHeader(header, [SECRET], now - 121_000)).toBeNull()
    expect(await verifyIngressHeader(header, [SECRET], now + 119_000)).toEqual(CLAIM)
    for (const junk of ['', 'v1', `${header} extra`, header.replace('v1', 'v2'), header.slice(0, -1)]) {
      expect(await verifyIngressHeader(junk, [SECRET], now)).toBeNull()
    }
    const path = await signIngressHeader(SECRET, { ...CLAIM, origin: 'https://cn.relay.example/x' }, now)
    expect(await verifyIngressHeader(path, [SECRET], now)).toBeNull()
  })
})

// Drives the Worker's router with stub objects and records what reaches them.
function harness(extra: Partial<Env> = {}) {
  const seen: { limiterKeys: string[]; forwarded: Record<string, string>[]; statuses: number[] } = { limiterKeys: [], forwarded: [], statuses: [] }
  // Metrics as '<event>:<label>' (kept out of `seen`, which compares requests with today's).
  const metrics: string[] = []
  const capture = async (request: Request) => {
    seen.forwarded.push(Object.fromEntries(request.headers))
    return new Response(null, { status: 204 })
  }
  const namespace = (stub: object) => ({ idFromName: (name: string) => name, get: () => stub })
  const env = {
    EDGE_BACKEND: 'spike',
    SPIKE_DEBUG: '1',
    RELAY_JWKS: '{"keys":[]}',
    RELAY_JWT_AUDIENCE: 'orca-relay',
    PING_INTERVAL_MS: '30000',
    SILENCE_TIMEOUT_MS: '75000',
    ORPHAN_GRACE_MS: '30000',
    HOST_RELAY: namespace({ fetch: capture, allocateConnId: async (id: string) => `${id}.0.conn` }),
    SPLICE_RELAY: namespace({ fetch: capture }),
    PREAUTH_LIMITER: { limit: async ({ key }: { key: string }) => (seen.limiterKeys.push(key), { success: true }) },
    METRICS: { writeDataPoint: ({ blobs }: { blobs: string[] }) => metrics.push(`${blobs[0]}:${blobs[1]}`) },
    ...extra
  } as unknown as Env
  const send = async (headers: Record<string, string> = {}) => {
    const base = { 'cf-connecting-ip': '203.0.113.1', upgrade: 'websocket', ...headers }
    for (const path of [`/v1/connect/${HOST}`, `/__spike/host/${HOST}`]) {
      seen.statuses.push((await worker.fetch(new Request(`https://edge.relay.example${path}`, { headers: base }), env)).status)
    }
    return seen
  }
  return { send, metrics, env }
}

describe('worker behind an ingress', () => {
  it('without the header, configuring a secret changes nothing', async () => {
    const today = await harness().send()
    expect(today.limiterKeys).toEqual(['phone:203.0.113.1'])
    expect(today.forwarded.map((h) => [h['x-edge-origin'], h['x-edge-place']])).toEqual([
      ['https://edge.relay.example', 'local'],
      ['https://edge.relay.example', 'local']
    ])
    expect(await harness({ INGRESS_SECRETS: SECRET }).send()).toEqual(today)
  })

  it('a header that fails to verify is dropped and the request is treated as direct', async () => {
    const today = await harness().send()
    const forged = { [INGRESS_HEADER]: await signIngressHeader(OLD_SECRET, CLAIM) }
    expect(await harness({ INGRESS_SECRETS: SECRET }).send(forged)).toEqual(today)
    // No secret configured: even a validly signed header is ignored.
    expect(await harness().send({ [INGRESS_HEADER]: await signIngressHeader(SECRET, CLAIM) })).toEqual(today)
  })

  it('a verified header supplies the relay origin, the pre-auth source and the place label', async () => {
    const seen = await harness({ INGRESS_SECRETS: `${SECRET},${OLD_SECRET}` }).send({ [INGRESS_HEADER]: await signIngressHeader(SECRET, CLAIM) })
    expect(seen.limiterKeys).toEqual(['phone:198.51.100.7'])
    for (const headers of seen.forwarded) {
      expect(headers['x-edge-origin']).toBe('https://cn.relay.example')
      expect(headers['x-edge-place']).toBe('local/cn')
      expect(headers[INGRESS_HEADER]).toBeUndefined()
    }
  })

  it('a short secret switches the signed mode off, loudly, and the edge keeps serving', async () => {
    const today = await harness().send()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness({ INGRESS_SECRETS: `${SECRET},short` })
    expect(await h.send({ [INGRESS_HEADER]: await signIngressHeader(SECRET, CLAIM) })).toEqual(today)
    expect(h.metrics).toContain('ingress_config_invalid:secret_too_short')
    expect(h.metrics).toContain('ingress_refused:')
    expect(JSON.stringify(errors.mock.calls)).toContain('relay_edge_ingress_config_invalid')
    errors.mockRestore()
  })
})

describe('token-mode ingress (a load balancer that cannot sign)', () => {
  const TOKEN = 't'.repeat(40)
  const tokenEnv = { INGRESS_TOKENS: `${TOKEN},${'u'.repeat(40)}`, INGRESS_ORIGINS: 'https://cn.relay.example', INGRESS_SOURCE_CIDRS: '34.96.0.0/20, 34.127.192.0/18, 2001:db8:a::/48' }
  const lb = (over: Record<string, string> = {}) => ({
    [INGRESS_HEADER]: `v1s cn https://cn.relay.example ${TOKEN}`,
    'cf-connecting-ip': '34.96.3.9',
    'x-orca-client-ip': '198.51.100.7',
    'x-orca-client-country': 'CN',
    ...over
  })

  it('trusts the header only with token, allowlisted origin and an egress source; strips it all before objects', async () => {
    const seen = await harness(tokenEnv).send(lb())
    expect(seen.limiterKeys).toEqual(['phone:198.51.100.7'])
    for (const headers of seen.forwarded) {
      expect(headers['x-edge-origin']).toBe('https://cn.relay.example')
      expect(headers['x-edge-place']).toBe('local/cn')
      expect([headers[INGRESS_HEADER], headers['x-orca-client-ip'], headers['x-orca-client-country']]).toEqual([undefined, undefined, undefined])
    }
    expect((await harness(tokenEnv).send(lb({ 'cf-connecting-ip': '2001:db8:a:ffff::1' }))).limiterKeys).toEqual(['phone:198.51.100.7'])
  })

  it('from the front door ranges but failing the rule: 403 before anything is keyed or forwarded', async () => {
    for (const headers of [
      lb({ [INGRESS_HEADER]: `v1s cn https://cn.relay.example ${'x'.repeat(40)}` }),
      lb({ [INGRESS_HEADER]: `v1s cn https://cn.relay.example ${TOKEN.slice(1)}` }),
      lb({ [INGRESS_HEADER]: `v1s cn https://evil.example ${TOKEN}` }),
      lb({ [INGRESS_HEADER]: `v1s cn https://cn.relay.example ${TOKEN} extra` }),
      lb({ 'x-orca-client-ip': '' }),
      lb({ 'x-orca-client-ip': '198.51.100.7, 203.0.113.5' }),
      { 'cf-connecting-ip': '34.127.200.1' }
    ]) {
      const h = harness(tokenEnv)
      const seen = await h.send(headers)
      expect(seen.statuses).toEqual([403, 403])
      expect(seen.limiterKeys).toEqual([])
      expect(seen.forwarded).toEqual([])
      expect(h.metrics).toEqual(['ingress_rejected:', 'ingress_rejected:'])
    }
  })

  it('outside the front door ranges, a token header is ignored and the request is direct, as today', async () => {
    const today = await harness().send()
    for (const ip of ['203.0.113.1', '34.96.16.1']) {
      const seen = await harness(tokenEnv).send(lb({ 'cf-connecting-ip': ip }))
      expect(seen.forwarded.map((h) => h['x-edge-origin'])).toEqual(today.forwarded.map((h) => h['x-edge-origin']))
      expect(seen.forwarded.map((h) => h['x-edge-place'])).toEqual(['local', 'local'])
      expect(seen.limiterKeys).toEqual([`phone:${ip}`])
    }
    // Token mode unset: even a perfect header from the ranges is ignored (no 403 either).
    const unset = await harness().send(lb())
    expect(unset.statuses).toEqual(today.statuses)
    expect(unset.limiterKeys).toEqual(['phone:34.96.3.9'])
    // Only the HMAC path is configured: a token header is not accepted by it.
    expect((await harness({ INGRESS_SECRETS: SECRET }).send(lb())).limiterKeys).toEqual(['phone:34.96.3.9'])
  })

  it('a partial or malformed token setup switches token mode off, reports why, and the edge keeps serving', async () => {
    const today = await harness().send()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const [bad, problem] of [
      [{ INGRESS_TOKENS: TOKEN }, 'token_mode_partial'],
      [{ ...tokenEnv, INGRESS_ORIGINS: '' }, 'token_mode_partial'],
      [{ ...tokenEnv, INGRESS_TOKENS: 'short' }, 'token_too_short'],
      [{ ...tokenEnv, INGRESS_ORIGINS: 'https://cn.relay.example/' }, 'origin_invalid'],
      [{ ...tokenEnv, INGRESS_ORIGINS: 'http://cn.relay.example' }, 'origin_invalid'],
      [{ ...tokenEnv, INGRESS_SOURCE_CIDRS: '34.96.0.0/33' }, 'cidr_invalid'],
      [{ ...tokenEnv, INGRESS_SOURCE_CIDRS: '34.96.0.0/20,0.0.0.0/0' }, 'cidr_too_broad'],
      [{ ...tokenEnv, INGRESS_SOURCE_CIDRS: '34.0.0.0/7' }, 'cidr_too_broad'],
      [{ ...tokenEnv, INGRESS_SOURCE_CIDRS: '2001::/15' }, 'cidr_too_broad']
    ] as const) {
      const h = harness(bad)
      // A front-door request is now treated as direct (no 403: token mode is off).
      const seen = await h.send(lb())
      expect(seen.statuses).toEqual(today.statuses)
      expect(seen.limiterKeys).toEqual(['phone:34.96.3.9'])
      expect(h.metrics).toContain(`ingress_config_invalid:${problem}`)
      expect(edgeConfig(h.env).ingressToken.tokens).toEqual([])
    }
    expect(edgeConfig(harness({ ...tokenEnv, INGRESS_SOURCE_CIDRS: '34.0.0.0/8,2001:db8::/16' }).env).ingressProblems).toEqual([])
    errors.mockRestore()
  })

  it("a malformed ingress config does not stop the host object's alarm: connected desktops keep their pings", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness({ INGRESS_TOKENS: TOKEN, INGRESS_SECRETS: 'short', INGRESS_SOURCE_CIDRS: 'nonsense' })
    const sent: string[] = []
    let attachment: Record<string, unknown> = {
      k: 'control',
      phase: 'active',
      claims: { exp: Date.now() + 3_600_000 },
      lastPongAt: Date.now(),
      lastPingAt: 0
    }
    const ws = {
      deserializeAttachment: () => attachment,
      serializeAttachment: (a: Record<string, unknown>) => (attachment = a),
      send: (text: string) => sent.push(text)
    }
    const storage = { get: async () => undefined, put: async () => {}, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} }
    const relay = new HostRelay({ getWebSockets: () => [ws], storage } as never, h.env)
    await relay.alarm()
    expect(sent.map((t) => JSON.parse(t).type)).toEqual(['ping'])
    errors.mockRestore()
  })

  it('places the client country reported by the ingress', () => {
    const request = new Request('https://edge.relay.example/v1/connect/x')
    Object.defineProperty(request, 'cf', { value: { continent: 'EU', colo: 'AMS', country: 'NL' } })
    expect(requestPlace(request, { name: 'cn', country: 'CN' })).toBe('EU/AMS/CN/cn')
    expect(requestPlace(request, { name: 'cn' })).toBe('EU/AMS/NL/cn')
  })
})

describe('address parsing', () => {
  it('parses IPv4/IPv6 and matches CIDRs by family', () => {
    const cidrs = ['34.96.0.0/20', '2001:db8::/32', '10.0.0.1/32'].map((c) => parseCidr(c)!)
    expect(inCidrs('34.96.15.255', cidrs)).toBe(true)
    expect(inCidrs('34.96.16.0', cidrs)).toBe(false)
    expect(inCidrs('10.0.0.1', cidrs)).toBe(true)
    expect(inCidrs('2001:DB8:ffff::1', cidrs)).toBe(true)
    expect(inCidrs('2001:db9::1', cidrs)).toBe(false)
    expect(inCidrs('::ffff:34.96.0.1', cidrs)).toBe(false)
    for (const bad of ['', '1.2.3', '256.1.1.1', '1::2::3', '1:2:3:4:5:6:7:8:9', 'g::1', '1:2:3:4:5:6:7::8']) expect(parseIp(bad)).toBeNull()
    expect(parseIp('::')).toEqual({ v6: true, value: 0n })
    expect(parseCidr('34.96.0.0/x')).toBeNull()
  })
})
