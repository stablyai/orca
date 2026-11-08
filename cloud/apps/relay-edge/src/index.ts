// Relay edge Worker: stateless router. Control sockets live in the host's object; phone and host
// data sockets live in the host's pooled splice objects.
import { HostRelay } from './host-relay'
import { SpliceRelay } from './splice-relay'
import { edgeConfig, type Env } from './env'
import { HOST_ID, readBearer, verifyRelayJwt } from './jwt'
import { SPLICE_SLOTS, makeConnId, parseConnId } from './splice-slot'
import { metric, requestPlace } from './metrics'
import { admitPreAuth, notOnEdge } from './preauth'
import { objectHealth } from './health'
import { AssignBodySchema, DrainBodySchema, EraseBodySchema, ExportBodySchema, verifyAdminRequest, type AdminOp } from './admin'

export { HostRelay, SpliceRelay }

const INTERNAL_HEADERS = ['x-edge-claims', 'x-edge-origin', 'x-edge-kind', 'x-edge-conn-id', 'x-edge-place']

function reject(status: number, retryAfter?: number): Response {
  const headers = retryAfter === undefined ? undefined : { 'retry-after': String(retryAfter) }
  return new Response(null, { status, headers })
}

function forward(
  env: Env,
  request: Request,
  relayHostId: string,
  extra: Record<string, string>,
  target: 'host' | 'splice' = 'host',
  spliceObject = ''
): Promise<Response> {
  const headers = new Headers(request.headers)
  for (const name of INTERNAL_HEADERS) { headers.delete(name) }
  headers.set('x-edge-origin', new URL(request.url).origin)
  headers.set('x-edge-place', requestPlace(request))
  for (const [name, value] of Object.entries(extra)) { headers.set(name, value) }
  const init = new Request(request.url, { method: 'GET', headers })
  if (target === 'splice') { return env.SPLICE_RELAY.get(env.SPLICE_RELAY.idFromName(spliceObject)).fetch(init) }
  return env.HOST_RELAY.get(env.HOST_RELAY.idFromName(relayHostId)).fetch(init)
}

// Director → edge (phase 2). 401 for any token problem; 400 for a body that fails its schema.
async function handleAdmin(env: Env, request: Request, op: AdminOp): Promise<Response> {
  const response = await handleAdminCall(env, request, op)
  let label = String(response.status)
  if (response.status === 200 || response.status === 409) {
    const outcome = ((await response.clone().json().catch(() => ({}))) as { outcome?: unknown }).outcome
    if (typeof outcome === 'string') { label = outcome }
  }
  metric(env, 'admin', 1, `${op}:${label}`, [], '', requestPlace(request))
  return response
}

async function handleAdminCall(env: Env, request: Request, op: AdminOp): Promise<Response> {
  if (request.method !== 'POST' || edgeConfig(env).backend !== 'object') { return reject(404) }
  const verified = await verifyAdminRequest(env, request, op)
  if (!verified) { return reject(401) }
  // Transitional (admin.ts): counts the director's calls still made without a jti.
  if (!verified.replay) { metric(env, 'admin_no_jti', 1, op, [], '', requestPlace(request)) }
  const { replay } = verified
  const host = (relayHostId: string) => env.HOST_RELAY.get(env.HOST_RELAY.idFromName(relayHostId))
  if (op === 'assign') {
    const body = AssignBodySchema.safeParse(verified.body)
    if (!body.success) { return reject(400) }
    try {
      const id = env.HOST_RELAY.idFromName(body.data.relayHostId)
      const stub = body.data.locationHint ? env.HOST_RELAY.get(id, { locationHint: body.data.locationHint }) : env.HOST_RELAY.get(id)
      const result = await stub.adminAssign(body.data, replay)
      const ok = result.outcome === 'applied' || result.outcome === 'unchanged'
      return Response.json(result, { status: ok ? 200 : 409 })
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 409 })
    }
  }
  if (op === 'export') {
    const body = ExportBodySchema.safeParse(verified.body)
    if (!body.success) { return reject(400) }
    const result = await host(body.data.relayHostId).adminExport(replay)
    return Response.json(result, { status: result.outcome === 'exported' ? 200 : 409 })
  }
  if (op === 'drain') {
    const body = DrainBodySchema.safeParse(verified.body)
    if (!body.success) { return reject(400) }
    const result = await host(body.data.relayHostId).adminDrain(replay)
    return Response.json(result, { status: result.outcome === 'replay' || result.outcome === 'jti_full' ? 409 : 200 })
  }
  const body = EraseBodySchema.safeParse(verified.body)
  if (!body.success) { return reject(400) }
  const { outcome } = await host(body.data.relayHostId).adminErase(body.data.userId, replay)
  return Response.json({ outcome }, { status: outcome === 'erased' ? 200 : 409 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Fails every request (500) on a misconfigured deploy rather than running with a wrong backend.
    edgeConfig(env)
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return Response.json({ ok: true, connectionCapacityProtocol: 2 })
    }
    if (url.search) { return reject(400) }
    if (url.pathname === '/__health/object') { return objectHealth(env, request) }
    const admin = url.pathname.match(/^\/__admin\/(assign|export|erase|drain)$/)
    if (admin) { return handleAdmin(env, request, admin[1] as AdminOp) }
    // Spike-only: force the object to reset (simulates eviction / runtime restart).
    const abort = url.pathname.match(/^\/__spike\/abort\/([^/]+)$/)
    if (abort && env.SPIKE_ADMIN === '1') {
      return forward(env, request, abort[1], { 'x-edge-kind': 'abort' })
    }
    const abortSplice = url.pathname.match(/^\/__spike\/abort-splice\/([^/]+)$/)
    if (abortSplice && env.SPIKE_ADMIN === '1') {
      const connId = decodeURIComponent(abortSplice[1])
      const parsed = parseConnId(connId)
      if (!parsed) { return reject(429) }
      // Resets the whole slot object: every splice currently in that slot.
      return forward(env, request, '', { 'x-edge-kind': 'abort', 'x-edge-conn-id': connId }, 'splice', parsed.object)
    }
    if (env.SPIKE_DEBUG === '1') {
      if (url.pathname === '/__spike/info') {
        const cf = (request as Request & { cf?: { colo?: string; country?: string } }).cf
        return Response.json({ colo: cf?.colo ?? 'local', country: cf?.country ?? null, version: env.EDGE_VERSION ?? 'dev', now: Date.now() })
      }
      // R6: per-operation database latency from this colo (fresh client per op, as the backend does).
      if (url.pathname === '/__spike/db' && env.HYPERDRIVE) {
        // Query strings are rejected above, so the count is fixed.
        const cf = (request as Request & { cf?: { colo?: string } }).cf
        const n = 6
        const { Client } = await import('pg')
        const ms: number[] = []
        for (let i = 0; i < n; i++) {
          const started = Date.now()
          const client = new Client({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 5000 })
          try {
            await client.connect()
            await client.query('SELECT 1')
            ms.push(Date.now() - started)
          } catch {
            ms.push(-1)
          } finally {
            await client.end().catch(() => {})
          }
        }
        return Response.json({ colo: cf?.colo ?? 'local', ms })
      }
      const info = url.pathname.match(/^\/__spike\/host\/([A-Za-z0-9_-]{16})$/)
      if (info) { return forward(env, request, info[1], { 'x-edge-kind': 'info' }) }
    }
    const isUpgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket'

    if (url.pathname === '/v1/host/control') {
      if (!isUpgrade) { return reject(426) }
      const token = readBearer(request.headers.get('authorization'))
      const verified = token ? await verifyRelayJwt(env, token) : null
      if (!verified?.ok) {
        // No keys to judge the token (cold isolate, auth unreachable): 503, not 401. Shipped
        // desktops treat any refused upgrade the same (a network error, retried through the
        // director), so this changes no client behavior; it keeps an outage out of the 401s.
        if (verified?.reason === 'keys_unavailable') {
          metric(env, 'control_upgrade', 1, 'keys_unavailable', [], '', requestPlace(request))
          return reject(503, 5)
        }
        return reject(401)
      }
      return forward(env, request, verified.claims.relayHostId, {
        'x-edge-kind': 'control',
        'x-edge-claims': JSON.stringify(verified.claims)
      })
    }

    const phone = url.pathname.match(/^\/v1\/connect\/([^/]+)$/)
    if (phone) {
      if (!(await admitPreAuth(env, request, 'phone'))) { return reject(429) }
      if (!isUpgrade) { return reject(426) }
      // 429 for malformed ids matches the GCE cells.
      if (!HOST_ID.test(phone[1])) { return reject(429) }
      // The host object picks the least-busy slot of its splice pool, so concurrent phones land in
      // different objects (isolation) and reuse existing ones (no object creation per connect).
      const host = env.HOST_RELAY.get(env.HOST_RELAY.idFromName(phone[1]))
      const connId = await host
        .allocateConnId(phone[1])
        .catch(() => makeConnId(phone[1], Math.floor(Math.random() * SPLICE_SLOTS)))
      if (connId === null) {
        metric(env, 'not_on_edge', 1, '', [], '', requestPlace(request))
        return notOnEdge()
      }
      const parsed = parseConnId(connId)!
      return forward(env, request, phone[1], { 'x-edge-kind': 'phone', 'x-edge-conn-id': connId }, 'splice', parsed.object)
    }

    const data = url.pathname.match(/^\/v1\/host\/data\/([^/]+)$/)
    if (data) {
      if (!(await admitPreAuth(env, request, 'data'))) { return reject(429) }
      if (!isUpgrade) { return reject(426) }
      const connId = decodeURIComponent(data[1])
      const parsed = parseConnId(connId)
      if (!parsed) { return reject(429) }
      return forward(env, request, parsed.relayHostId, { 'x-edge-kind': 'data', 'x-edge-conn-id': connId }, 'splice', parsed.object)
    }
    return reject(404)
  }
} satisfies ExportedHandler<Env>
