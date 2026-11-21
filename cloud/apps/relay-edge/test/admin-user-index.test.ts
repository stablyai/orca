// The erasure index's signed admin ops through the Worker: list-hosts, index-host (backfill),
// erase-user-index. Same token checks and single-use jti as the host ops.
import { createHash, randomBytes } from 'node:crypto'
import { SignJWT } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { EDGE_URL, baseEnv, hostNamespace, stubObjectGlobals } from './director-fixture'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  }
}))
const { default: worker, HostRelay, UserHosts } = await import('../src/index')

const HOST = 'AbCdEfGhIjKlMnOp'
const OTHER = 'QrStUvWxYz012345'
const ADMIN_KEY = 'k'.repeat(40)
const ADMIN_ISSUER = 'https://director.test.invalid'
const ERASE_KEY = randomBytes(36).toString('base64url')
const ERASE_ISSUER = 'https://erasure.test.invalid'

beforeAll(() => {
  stubObjectGlobals()
})

type Signed = { op: string; body: string; key?: string; issuer?: string; jti?: string }

async function sign({ op, body, key = ADMIN_KEY, issuer = ADMIN_ISSUER, jti = randomBytes(12).toString('base64url') }: Signed): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ purpose: 'edge-admin', op, bodySha256: createHash('sha256').update(body).digest('base64url'), jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(issuer)
    .setAudience('orca-relay-edge-admin')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(new TextEncoder().encode(key))
}

function edge() {
  const env: Record<string, unknown> = { ...baseEnv('{"keys":[]}'), ERASE_SIGNING_KEY: ERASE_KEY, ERASE_ISSUER }
  const hosts = hostNamespace((ctx) => new HostRelay(ctx, env))
  const users = hostNamespace((ctx) => new UserHosts(ctx, env))
  env.HOST_RELAY = hosts.namespace
  env.USER_HOSTS = users.namespace
  const call = async (path: string, body: object, token?: string) => {
    const raw = JSON.stringify(body)
    const auth = token ?? (await sign({ op: path, body: raw }))
    const response = await worker.fetch(
      new Request(`${EDGE_URL}/__admin/${path}`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-length': String(raw.length) }, body: raw }),
      env
    )
    return { status: response.status, body: response.status === 200 || response.status === 409 ? await response.json() : null }
  }
  return { env, hosts, users, call }
}

describe('erasure index admin ops', () => {
  it('list-hosts for an unknown user is an empty list, and creates no index storage', async () => {
    const e = edge()
    expect(await e.call('list-hosts', { userId: 'nobody' })).toEqual({ status: 200, body: { relayHostIds: [] } })
    expect(e.users.objects.get('nobody')?.state.tables()).toBe(0)
    expect(e.users.objects.get('nobody')?.state.kv.size).toBe(0)
  })

  it('index-host (backfill) adds, list-hosts lists, erase-user-index empties', async () => {
    const e = edge()
    expect(await e.call('index-host', { userId: 'user-1', relayHostId: HOST })).toEqual({ status: 200, body: { outcome: 'indexed' } })
    expect(await e.call('index-host', { userId: 'user-1', relayHostId: OTHER })).toEqual({ status: 200, body: { outcome: 'indexed' } })
    expect(await e.call('index-host', { userId: 'user-1', relayHostId: HOST })).toEqual({ status: 200, body: { outcome: 'indexed' } })
    expect(await e.call('list-hosts', { userId: 'user-1' })).toEqual({ status: 200, body: { relayHostIds: [HOST, OTHER].sort() } })
    expect(await e.call('list-hosts', { userId: 'user-2' })).toEqual({ status: 200, body: { relayHostIds: [] } })
    expect(await e.call('erase-user-index', { userId: 'user-1' })).toEqual({ status: 200, body: { outcome: 'erased' } })
    expect(await e.call('list-hosts', { userId: 'user-1' })).toEqual({ status: 200, body: { relayHostIds: [] } })
    // No host object was touched.
    expect(e.hosts.objects.size).toBe(0)
  })

  it('refuses a missing, wrong-key, wrong-op or wrong-body token (401) and a malformed body (400)', async () => {
    const e = edge()
    const body = { userId: 'user-1', relayHostId: HOST }
    const raw = JSON.stringify(body)
    expect((await e.call('index-host', body, 'not.a.token')).status).toBe(401)
    expect((await e.call('index-host', body, await sign({ op: 'index-host', body: raw, key: 'x'.repeat(40) }))).status).toBe(401)
    expect((await e.call('index-host', body, await sign({ op: 'list-hosts', body: raw }))).status).toBe(401)
    expect((await e.call('index-host', body, await sign({ op: 'index-host', body: '{}' }))).status).toBe(401)
    expect((await e.call('index-host', { userId: 'user-1', relayHostId: 'short' })).status).toBe(400)
    expect((await e.call('list-hosts', { userId: 'user-1', extra: 1 })).status).toBe(400)
    expect(e.users.objects.size).toBe(0)
  })

  it('the erasure job key signs list-hosts and erase-user-index, never index-host', async () => {
    const e = edge()
    const user = JSON.stringify({ userId: 'user-1' })
    const erasure = { key: ERASE_KEY, issuer: ERASE_ISSUER }
    expect((await e.call('list-hosts', { userId: 'user-1' }, await sign({ op: 'list-hosts', body: user, ...erasure }))).status).toBe(200)
    expect((await e.call('erase-user-index', { userId: 'user-1' }, await sign({ op: 'erase-user-index', body: user, ...erasure }))).status).toBe(200)
    const index = JSON.stringify({ userId: 'user-1', relayHostId: HOST })
    expect((await e.call('index-host', { userId: 'user-1', relayHostId: HOST }, await sign({ op: 'index-host', body: index, ...erasure }))).status).toBe(401)
  })

  it('a token is single use: a replay is 409 replay and changes nothing', async () => {
    const e = edge()
    const index = JSON.stringify({ userId: 'user-1', relayHostId: HOST })
    const token = await sign({ op: 'index-host', body: index, jti: 'jti-index-0123456789' })
    expect((await e.call('index-host', { userId: 'user-1', relayHostId: HOST }, token)).status).toBe(200)
    expect(await e.call('index-host', { userId: 'user-1', relayHostId: HOST }, token)).toEqual({ status: 409, body: { outcome: 'replay' } })
    const list = await sign({ op: 'list-hosts', body: JSON.stringify({ userId: 'user-1' }), jti: 'jti-list-0123456789ab' })
    expect((await e.call('list-hosts', { userId: 'user-1' }, list)).status).toBe(200)
    expect(await e.call('list-hosts', { userId: 'user-1' }, list)).toEqual({ status: 409, body: { outcome: 'replay' } })
    const erase = await sign({ op: 'erase-user-index', body: JSON.stringify({ userId: 'user-1' }), jti: 'jti-erase-0123456789a' })
    await e.call('index-host', { userId: 'user-1', relayHostId: OTHER })
    const erasing = await e.call('erase-user-index', { userId: 'user-1' }, erase)
    expect(erasing.status).toBe(200)
    // The erase wiped the index with its jtis: a copy finds an empty index and erases nothing more.
    expect((await e.call('erase-user-index', { userId: 'user-1' }, erase)).status).toBe(200)
    expect(await e.call('list-hosts', { userId: 'user-1' })).toEqual({ status: 200, body: { relayHostIds: [] } })
  })

  it('without the USER_HOSTS binding the ops answer 404; the host ops route as before', async () => {
    const e = edge()
    delete e.env.USER_HOSTS
    expect((await e.call('list-hosts', { userId: 'user-1' })).status).toBe(404)
    expect((await e.call('index-host', { userId: 'user-1', relayHostId: HOST })).status).toBe(404)
    expect((await e.call('erase-user-index', { userId: 'user-1' })).status).toBe(404)
    expect(await e.call('erase', { userId: 'user-1', relayHostId: HOST })).toEqual({ status: 200, body: { outcome: 'erased' } })
    expect((await e.call('list-hostz', { userId: 'user-1' })).status).toBe(404)
  })
})
