// Relay edge Worker: stateless router. Control sockets live in the host's object; phone and host
// data sockets live in the host's pooled splice objects.
import { HostRelay } from './host-relay'
import { SpliceRelay } from './splice-relay'
import type { Env } from './env'
import { HOST_ID, verifyRelayJwt } from './jwt'
import { SPLICE_SLOTS, makeConnId, parseConnId } from './splice-slot'

export { HostRelay, SpliceRelay }

const INTERNAL_HEADERS = ['x-edge-claims', 'x-edge-origin', 'x-edge-kind', 'x-edge-conn-id']

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
  for (const name of INTERNAL_HEADERS) headers.delete(name)
  headers.set('x-edge-origin', new URL(request.url).origin)
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  const init = new Request(request.url, { method: 'GET', headers })
  if (target === 'splice') return env.SPLICE_RELAY.get(env.SPLICE_RELAY.idFromName(spliceObject)).fetch(init)
  return env.HOST_RELAY.get(env.HOST_RELAY.idFromName(relayHostId)).fetch(init)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return Response.json({ ok: true, connectionCapacityProtocol: 2 })
    }
    if (url.search) return reject(400)
    // Spike-only: force the object to reset (simulates eviction / runtime restart).
    const abort = url.pathname.match(/^\/__spike\/abort\/([^/]+)$/)
    if (abort && env.SPIKE_ADMIN === '1') {
      return forward(env, request, abort[1], { 'x-edge-kind': 'abort' })
    }
    const abortSplice = url.pathname.match(/^\/__spike\/abort-splice\/([^/]+)$/)
    if (abortSplice && env.SPIKE_ADMIN === '1') {
      const connId = decodeURIComponent(abortSplice[1])
      const parsed = parseConnId(connId)
      if (!parsed) return reject(429)
      // Resets the whole slot object: every splice currently in that slot.
      return forward(env, request, '', { 'x-edge-kind': 'abort', 'x-edge-conn-id': connId }, 'splice', parsed.object)
    }
    if (env.SPIKE_DEBUG === '1') {
      if (url.pathname === '/__spike/info') {
        const cf = (request as Request & { cf?: { colo?: string; country?: string } }).cf
        return Response.json({ colo: cf?.colo ?? 'local', country: cf?.country ?? null, version: env.EDGE_VERSION ?? 'dev', now: Date.now() })
      }
      const info = url.pathname.match(/^\/__spike\/host\/([A-Za-z0-9_-]{16})$/)
      if (info) return forward(env, request, info[1], { 'x-edge-kind': 'info' })
    }
    const isUpgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket'

    if (url.pathname === '/v1/host/control') {
      if (!isUpgrade) return reject(426)
      const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
      const claims = token ? await verifyRelayJwt(env, token) : null
      if (!claims) return reject(401)
      return forward(env, request, claims.relayHostId, {
        'x-edge-kind': 'control',
        'x-edge-claims': JSON.stringify(claims)
      })
    }

    const phone = url.pathname.match(/^\/v1\/connect\/([^/]+)$/)
    if (phone) {
      if (!isUpgrade) return reject(426)
      // 429 for malformed ids matches the GCE cells.
      if (!HOST_ID.test(phone[1])) return reject(429)
      // The host object picks the least-busy slot of its splice pool, so concurrent phones land in
      // different objects (isolation) and reuse existing ones (no object creation per connect).
      const host = env.HOST_RELAY.get(env.HOST_RELAY.idFromName(phone[1]))
      const connId = await host
        .allocateConnId(phone[1])
        .catch(() => makeConnId(phone[1], Math.floor(Math.random() * SPLICE_SLOTS)))
      const parsed = parseConnId(connId)!
      return forward(env, request, phone[1], { 'x-edge-kind': 'phone', 'x-edge-conn-id': connId }, 'splice', parsed.object)
    }

    const data = url.pathname.match(/^\/v1\/host\/data\/([^/]+)$/)
    if (data) {
      if (!isUpgrade) return reject(426)
      const connId = decodeURIComponent(data[1])
      const parsed = parseConnId(connId)
      if (!parsed) return reject(429)
      return forward(env, request, parsed.relayHostId, { 'x-edge-kind': 'data', 'x-edge-conn-id': connId }, 'splice', parsed.object)
    }
    return reject(404)
  }
} satisfies ExportedHandler<Env>
