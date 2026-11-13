import { describe, expect, it, vi } from 'vitest'
import { INGRESS_HEADER, signIngressHeader, verifyIngressHeader } from '../../../packages/relay-contract/src/ingress-header'
import type { Env } from '../src/env'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))
const { default: worker } = await import('../src/index')

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
  const seen: { limiterKeys: string[]; forwarded: Record<string, string>[] } = { limiterKeys: [], forwarded: [] }
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
    ...extra
  } as unknown as Env
  const send = async (headers: Record<string, string> = {}) => {
    const base = { 'cf-connecting-ip': '203.0.113.1', upgrade: 'websocket', ...headers }
    await worker.fetch(new Request(`https://edge.relay.example/v1/connect/${HOST}`, { headers: base }), env)
    await worker.fetch(new Request(`https://edge.relay.example/__spike/host/${HOST}`, { headers: base }), env)
    return seen
  }
  return { send }
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

  it('refuses to start with a short ingress secret', async () => {
    await expect(harness({ INGRESS_SECRETS: `${SECRET},short` }).send()).rejects.toThrow('relay_edge_config_ingress')
  })
})
