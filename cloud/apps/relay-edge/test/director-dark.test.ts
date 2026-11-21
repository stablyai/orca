// The director endpoints are dark: without DIRECTOR_HOSTNAME (every environment today), or for any
// other hostname, or on a backend other than the object one, the Worker answers exactly as before
// (status, headers, body, what reaches the objects, limiter keys, metrics).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { INGRESS_HEADER } from '../../../packages/relay-contract/src/ingress-header'
import { DIRECTOR_HOST, DIRECTOR_VARS, EDGE_URL, FRONT_DOOR_URL, baseEnv, relaySigner, stubUpgradeGlobals, type FakeServerSocket } from './director-fixture'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  }
}))
const { default: worker } = await import('../src/index')

const HOST = 'AbCdEfGhIjKlMnOp'
const EDGE_HOST = new URL(EDGE_URL).hostname
let servers: FakeServerSocket[]

beforeAll(() => {
  servers = stubUpgradeGlobals()
})
afterEach(() => {
  vi.useRealTimers()
})

// The Worker over stub objects that record every call.
function harness(vars: Record<string, string> = {}) {
  const calls: string[] = []
  const metrics: string[] = []
  const limiterKeys: string[] = []
  const host = {
    fetch: async (request: Request) => (calls.push(`host.fetch ${request.headers.get('x-edge-kind')}`), new Response(null, { status: 204 })),
    allocateConnId: async (id: string) => (calls.push('host.allocateConnId'), `${id}.0.conn`),
    directorAssign: async (ask: { cellUrl: string }) => (calls.push(`host.directorAssign ${ask.cellUrl}`), { outcome: 'assigned', cellUrl: ask.cellUrl, assignmentEpoch: 4 }),
    directorVerify: async () => (calls.push('host.directorVerify'), { outcome: 'none' })
  }
  const splice = { fetch: async (request: Request) => (calls.push(`splice.fetch ${request.headers.get('x-edge-kind')}`), new Response(null, { status: 204 })) }
  const namespace = (stub: object) => ({ idFromName: (name: string) => name, get: () => stub })
  const env = {
    ...baseEnv('{"keys":[]}'),
    HOST_RELAY: namespace(host),
    SPLICE_RELAY: namespace(splice),
    PREAUTH_LIMITER: { limit: async ({ key }: { key: string }) => (limiterKeys.push(key), { success: true }) },
    METRICS: { writeDataPoint: ({ blobs }: { blobs: string[] }) => metrics.push(`${blobs[0]}:${blobs[1]}`) },
    ...vars
  }
  const send = async (hostname: string, path: string, init: RequestInit = {}) => {
    const response = await worker.fetch(new Request(`https://${hostname}${path}`, { ...init, headers: { 'cf-connecting-ip': '203.0.113.1', ...init.headers } }), env)
    return { status: response.status, headers: [...response.headers], body: await response.text() }
  }
  return { send, calls, metrics, limiterKeys }
}

const upgrade = { headers: { upgrade: 'websocket' } }
const REQUESTS: [string, RequestInit][] = [
  ['/v1/assign', { method: 'POST', headers: { authorization: 'Bearer x.y.z' }, body: JSON.stringify({ v: 1, relayHostId: HOST }) }],
  ['/v1/resolve', { method: 'POST', body: JSON.stringify({ v: 1, relayHostId: HOST, resumeToken: 'R'.repeat(43) }) }],
  ['/v1/regions', {}],
  [`/v1/connect/${HOST}`, upgrade],
  [`/v1/connect/${HOST}`, {}],
  ['/v1/connect/not-a-host-id', upgrade],
  ['/v1/host/control', {}],
  ['/health', {}],
  ['/v1/regions?x=1', {}],
  ['/elsewhere', {}]
]

async function replay(h: ReturnType<typeof harness>, hostnames: string[]) {
  const answers = []
  for (const hostname of hostnames) {
    for (const [path, init] of REQUESTS) { answers.push([hostname, path, await h.send(hostname, path, init)]) }
  }
  return { answers, calls: h.calls, metrics: h.metrics, limiterKeys: h.limiterKeys }
}

describe('director endpoints are dark', () => {
  it('without DIRECTOR_HOSTNAME the director paths are today\'s answers on every hostname', async () => {
    const today = await replay(harness(), [EDGE_HOST, DIRECTOR_HOST])
    const answer = (hostname: string, path: string, index = 0) => today.answers.filter((a) => a[0] === hostname && a[1] === path)[index]?.[2]
    for (const hostname of [EDGE_HOST, DIRECTOR_HOST]) {
      for (const path of ['/v1/assign', '/v1/resolve', '/v1/regions']) { expect(answer(hostname, path)).toEqual({ status: 404, headers: [], body: '' }) }
      // A phone connect goes to the host's splice, as it always has.
      expect(answer(hostname, `/v1/connect/${HOST}`)).toMatchObject({ status: 204 })
      expect(answer(hostname, `/v1/connect/${HOST}`, 1)).toMatchObject({ status: 426 })
    }
    expect(today.calls).toEqual(['host.allocateConnId', 'splice.fetch phone', 'host.allocateConnId', 'splice.fetch phone'])
  })

  it('set for another hostname, set on a non-object backend, or malformed: identical to unset', async () => {
    const today = await replay(harness(), [EDGE_HOST, DIRECTOR_HOST])
    expect(await replay(harness({ ...DIRECTOR_VARS, DIRECTOR_HOSTNAME: 'other.relay.example' }), [EDGE_HOST, DIRECTOR_HOST])).toEqual(today)
    expect(await replay(harness({ ...DIRECTOR_VARS, EDGE_BACKEND: 'spike', SPIKE_DEBUG: '1' }), [EDGE_HOST, DIRECTOR_HOST])).toEqual(
      await replay(harness({ EDGE_BACKEND: 'spike', SPIKE_DEBUG: '1' }), [EDGE_HOST, DIRECTOR_HOST])
    )
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const malformed = await replay(harness({ ...DIRECTOR_VARS, DIRECTOR_EDGE_URL: 'edge.relay.example' }), [EDGE_HOST, DIRECTOR_HOST])
    // The problem is reported once (metric + log); the answers are today's.
    expect(malformed.metrics.filter((m) => m.startsWith('director:'))).toEqual(['director:config:edge_url_invalid'])
    expect({ ...malformed, metrics: malformed.metrics.filter((m) => !m.startsWith('director:')) }).toEqual(today)
    expect(JSON.stringify(errors.mock.calls)).toContain('relay_edge_director_config_invalid')
    errors.mockRestore()
  })

  it('on the edge hostname the edge keeps every route when the director is on', async () => {
    const today = await replay(harness(), [EDGE_HOST])
    expect(await replay(harness(DIRECTOR_VARS), [EDGE_HOST])).toEqual(today)
  })
})

describe('on the director hostname', () => {
  it('answers only the director paths; the edge routes are not served there', async () => {
    const h = harness(DIRECTOR_VARS)
    expect((await h.send(DIRECTOR_HOST, '/v1/regions')).status).toBe(200)
    for (const path of ['/v1/host/control', '/v1/host/data/x.0.conn', '/__spike/info', '/v1/assign/extra', '/elsewhere']) {
      expect((await h.send(DIRECTOR_HOST, path, upgrade)).status).toBe(404)
    }
    expect((await h.send(DIRECTOR_HOST, '/v1/regions', { method: 'POST' })).status).toBe(404)
    expect((await h.send(DIRECTOR_HOST, '/health')).body).toBe(JSON.stringify({ ok: true, connectionCapacityProtocol: 2 }))
    expect(h.calls).toEqual([])
    expect(h.metrics).toContain('director:regions:200')
  })

  it('refuses oversized bodies and malformed first frames before any object call', async () => {
    const h = harness(DIRECTOR_VARS)
    expect((await h.send(DIRECTOR_HOST, '/v1/resolve', { method: 'POST', body: 'x'.repeat(5 * 1024) })).status).toBe(413)
    const { answerInviteFrame } = await import('../src/director')
    const neverCalled = { directorAssign: async () => ({ outcome: 'unavailable' as const }), directorVerify: async () => ({ outcome: 'none' as const }) }
    for (const frame of ['junk', JSON.stringify({ type: 'relay-hello', v: 1 }), JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: 'short' }), 'x'.repeat(5_000)]) {
      expect(await answerInviteFrame(frame, HOST, neverCalled, EDGE_URL)).toEqual({ frame: JSON.stringify({ type: 'relay-hello', ok: false, code: 4401 }), code: 4401, reason: 'invalid relay auth' })
    }
    expect(h.calls).toEqual([])
  })

  it('keys the resolve and invite limits per source, apart from each other', async () => {
    const h = harness(DIRECTOR_VARS)
    await h.send(DIRECTOR_HOST, '/v1/resolve', { method: 'POST', body: '{}' })
    await h.send(DIRECTOR_HOST, `/v1/connect/${HOST}`, upgrade)
    expect(h.limiterKeys).toEqual(['resolve:203.0.113.1', 'phone:203.0.113.1'])
  })

  it('the invite move refuses non-upgrades and malformed ids as the edge does, and times out a silent phone', async () => {
    const h = harness(DIRECTOR_VARS)
    expect((await h.send(DIRECTOR_HOST, `/v1/connect/${HOST}`)).status).toBe(426)
    expect((await h.send(DIRECTOR_HOST, '/v1/connect/short', upgrade)).status).toBe(429)
    vi.useFakeTimers()
    expect((await h.send(DIRECTOR_HOST, `/v1/connect/${HOST}`, upgrade)).status).toBe(101)
    const server = servers.at(-1)!
    vi.advanceTimersByTime(2_000)
    expect(server.closed).toEqual({ code: 4401, reason: 'first frame timeout' })
    expect(server.sent).toEqual([])
    expect(h.calls).toEqual([])
  })

  it('behind a trusted load balancer: matched on the dialled origin, routed by its client country', async () => {
    const signer = await relaySigner()
    const TOKEN = 't'.repeat(40)
    const lb = { INGRESS_TOKENS: TOKEN, INGRESS_ORIGINS: `https://${DIRECTOR_HOST}`, INGRESS_SOURCE_CIDRS: '34.96.0.0/20', RELAY_JWKS: signer.jwks }
    const h = harness({ ...DIRECTOR_VARS, ...lb })
    const headers = { [INGRESS_HEADER]: `v1s lb https://${DIRECTOR_HOST} ${TOKEN}`, 'cf-connecting-ip': '34.96.3.9', 'x-orca-client-ip': '198.51.100.7', 'x-orca-client-country': 'CN' }
    // The Worker's own hostname is the edge's; the client dialled the director.
    expect((await h.send(EDGE_HOST, '/v1/regions', { headers })).status).toBe(200)
    expect((await h.send(EDGE_HOST, '/v1/resolve', { method: 'POST', headers, body: '{}' })).status).toBe(400)
    expect(h.limiterKeys).toEqual(['resolve:198.51.100.7'])
    const token = await signer.mint({ user: 'user-1', host: HOST })
    const assigned = await h.send(EDGE_HOST, '/v1/assign', { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}` }, body: JSON.stringify({ v: 1, relayHostId: HOST }) })
    expect(JSON.parse(assigned.body)).toMatchObject({ cellUrl: FRONT_DOOR_URL, assignmentEpoch: 4 })
    expect(h.calls).toEqual([`host.directorAssign ${FRONT_DOOR_URL}`])
  })
})
