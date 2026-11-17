// The host object's erasure index writes (dark): queued by the edge-native director's assign,
// sent from the object's alarm, retried until the index acknowledges. Off without the director.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { USER_INDEX_PENDING_KEY, USER_INDEX_RETRY_MIN_MS } from '../src/user-index'
import { DIRECTOR_URL, DIRECTOR_VARS, EDGE_URL, baseEnv, hostNamespace, relaySigner, stubObjectGlobals, type RelaySigner } from './director-fixture'

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
let signer: RelaySigner

beforeAll(async () => {
  stubObjectGlobals()
  signer = await relaySigner()
})
afterEach(() => {
  vi.useRealTimers()
})

// Real host and index objects. `failing`: every index call throws (an unreachable index).
function edge(vars: Record<string, unknown> = DIRECTOR_VARS) {
  const env: Record<string, unknown> = { ...baseEnv(signer.jwks), ...vars }
  const hosts = hostNamespace((ctx) => new HostRelay(ctx, env))
  const users = hostNamespace((ctx) => new UserHosts(ctx, env))
  const control = { failing: false, calls: 0 }
  env.HOST_RELAY = hosts.namespace
  env.USER_HOSTS = {
    idFromName: users.namespace.idFromName,
    get: (id: string) => {
      const index = users.namespace.get(id)
      const call = async (op: () => Promise<void>) => {
        control.calls += 1
        if (control.failing) { throw new Error('index unreachable') }
        await op()
      }
      return { add: (relayHostId: string) => call(() => index.add(relayHostId)), remove: (relayHostId: string) => call(() => index.remove(relayHostId)) }
    }
  }
  const host = () => hosts.namespace.get(HOST)
  const hostState = () => hosts.objects.get(HOST)!.state
  const listed = async (userId: string) => (await users.namespace.get(userId).list()).map((h) => h.relayHostId)
  const assign = async (user: string) => {
    const token = await signer.mint({ user, host: HOST })
    const response = await worker.fetch(new Request(`${DIRECTOR_URL}/v1/assign`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ v: 1, relayHostId: HOST }) }), env)
    expect(response.status).toBe(200)
  }
  // As the runtime runs it: the alarm that fired is no longer set while its handler runs.
  const fire = async () => {
    await hostState().ctx.storage.deleteAlarm()
    await host().alarm()
  }
  return { env, host, hostState, listed, assign, fire, control, users }
}

describe('erasure index writes from the director assign', () => {
  it('a new host is queued at assign (not sent inline) and indexed by the alarm', async () => {
    const e = edge()
    await e.assign('user-1')
    expect(e.control.calls).toBe(0)
    expect(e.hostState().kv.get(USER_INDEX_PENDING_KEY)).toMatchObject({ relayHostId: HOST, ops: { 'user-1': 'add' } })
    // The first attempt is due at once.
    expect(await e.hostState().ctx.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1)
    await e.fire()
    expect(await e.listed('user-1')).toEqual([HOST])
    expect(e.hostState().kv.has(USER_INDEX_PENDING_KEY)).toBe(false)
    // A later assign by the same user writes nothing more.
    await e.assign('user-1')
    expect(e.hostState().kv.has(USER_INDEX_PENDING_KEY)).toBe(false)
  })

  it('an account switch moves the host from the earlier user to the new one', async () => {
    const e = edge()
    await e.assign('user-1')
    await e.fire()
    await e.assign('user-2')
    expect(e.hostState().kv.get(USER_INDEX_PENDING_KEY)).toMatchObject({ ops: { 'user-1': 'remove', 'user-2': 'add' } })
    await e.fire()
    expect(await e.listed('user-1')).toEqual([])
    expect(await e.listed('user-2')).toEqual([HOST])
  })

  it('a failed write stays pending and is retried from the alarm with backoff until acknowledged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const e = edge()
    e.control.failing = true
    await e.assign('user-1')
    await e.fire()
    const pending = e.hostState().kv.get(USER_INDEX_PENDING_KEY)
    expect(pending).toMatchObject({ ops: { 'user-1': 'add' }, attempts: 1, retryAt: Date.now() + USER_INDEX_RETRY_MIN_MS })
    expect(await e.hostState().ctx.storage.getAlarm()).toBe(Date.now() + USER_INDEX_RETRY_MIN_MS)
    // Not due yet: no call.
    const calls = e.control.calls
    await e.fire()
    expect(e.control.calls).toBe(calls)
    // An account switch while still failing: both users' writes wait, the earlier add is replaced.
    await e.assign('user-2')
    e.control.failing = false
    vi.setSystemTime(Date.now() + USER_INDEX_RETRY_MIN_MS)
    await e.fire()
    expect(await e.listed('user-1')).toEqual([])
    expect(await e.listed('user-2')).toEqual([HOST])
    expect(e.hostState().kv.has(USER_INDEX_PENDING_KEY)).toBe(false)
  })

  it('a deploy without the index binding keeps the write pending (never dropped)', async () => {
    const e = edge()
    delete e.env.USER_HOSTS
    await e.assign('user-1')
    await e.fire()
    expect(e.hostState().kv.get(USER_INDEX_PENDING_KEY)).toMatchObject({ ops: { 'user-1': 'add' }, attempts: 1 })
  })
})

describe('the write path is off without the director endpoints', () => {
  it('a host assigned with DIRECTOR_HOSTNAME unset queues nothing and reads no marker', async () => {
    const e = edge({})
    const answer = await e.host().directorAssign({ userId: 'user-1', relayHostId: HOST, cellUrl: EDGE_URL })
    expect(answer).toMatchObject({ outcome: 'assigned', assignmentEpoch: 1 })
    expect(e.hostState().kv.has(USER_INDEX_PENDING_KEY)).toBe(false)
    // A marker left from a time the director was on is not sent while it is off.
    await e.hostState().ctx.storage.put(USER_INDEX_PENDING_KEY, { relayHostId: HOST, ops: { 'user-1': 'add' }, attempts: 0, retryAt: 0 })
    await e.fire()
    expect(e.control.calls).toBe(0)
    // Its retry time does not arm the alarm either: only the daily sweep does.
    expect(await e.hostState().ctx.storage.getAlarm()).toBe(e.hostState().kv.get('sweepAt'))
  })

  it('a malformed director config is off too', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = edge({ ...DIRECTOR_VARS, DIRECTOR_EDGE_URL: 'edge.relay.example' })
    await e.host().directorAssign({ userId: 'user-1', relayHostId: HOST, cellUrl: EDGE_URL })
    expect(e.hostState().kv.has(USER_INDEX_PENDING_KEY)).toBe(false)
    errors.mockRestore()
  })
})
