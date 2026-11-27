// Connector wake Worker: a stateless router in front of one ConnectorHost object per host.
//   GET  /v1/connector/wake  desktop upgrade (wake token, checked here only)
//   POST /__admin/wake       connector publisher (admin.ts); optional kind picks the frame
//   GET  /__health/object    alerts deep probe (health.ts)
import {
  CONNECTOR_WAKE_ADMIN_PATH,
  CONNECTOR_WAKE_CLOSE_CODE,
  CONNECTOR_WAKE_GAP_HEADER,
  CONNECTOR_WAKE_PATH,
  ConnectorWakeAdminRequestSchema,
  type ConnectorWakeAdminResponse,
  type ConnectorWakeKind
} from '../../../packages/connector-contract/src/wake-messages'
import { verifyAdminRequest } from './admin'
import { ConnectorHost, HOST_ID_HEADER, PLACE_HEADER, type WakeResult } from './connector-host'
import { wakeConfig, type Env } from './env'
import { objectHealth } from './health'
import { hostObjectName, isHostId } from './host-id'
import { readBearer, verifyWakeToken } from './jwt'
import { metric, requestPlace } from './metrics'
import { admitPreAuth } from './preauth'

export { ConnectorHost }

const INTERNAL_HEADER_PREFIXES = ['x-edge-', 'x-wake-']
// Objects called at once by one admin wake.
const WAKE_FANOUT = 50
// A gap longer than this is reported as this (a desktop asleep for days is not a reconnect gap).
const GAP_MAX_MS = 7 * 24 * 60 * 60 * 1000

function reject(status: number, retryAfter?: number): Response {
  const headers = retryAfter === undefined ? undefined : { 'retry-after': String(retryAfter) }
  return new Response(null, { status, headers })
}

function country(request: Request): string | undefined {
  return (request as Request & { cf?: { country?: string } }).cf?.country
}

// Answers the upgrade and closes it at once, without touching an object.
function closedSocket(code: number, reason: string): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
  server.accept()
  server.close(code, reason)
  return new Response(null, { status: 101, webSocket: client })
}

function host(env: Env, hostId: string): DurableObjectStub<ConnectorHost> {
  return env.CONNECTOR_HOST.get(env.CONNECTOR_HOST.idFromName(hostObjectName(hostId)))
}

async function handleUpgrade(env: Env, request: Request): Promise<Response> {
  const place = requestPlace(request)
  if (!(await admitPreAuth(env, request, 'wake'))) { return reject(429) }
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') { return reject(426) }
  const from = country(request)
  if (from && wakeConfig(env).refuseCountries.has(from.toUpperCase())) {
    metric(env, 'refuse', 1, String(CONNECTOR_WAKE_CLOSE_CODE.COUNTRY_REFUSED), [], 'country', place)
    return closedSocket(CONNECTOR_WAKE_CLOSE_CODE.COUNTRY_REFUSED, 'country refused')
  }
  const token = readBearer(request.headers.get('authorization'))
  const verified = token ? await verifyWakeToken(env, token) : null
  if (!verified?.ok) {
    if (verified?.reason === 'keys_unavailable') {
      metric(env, 'upgrade', 1, 'keys_unavailable', [], '', place)
      return reject(503, 5)
    }
    // detail: which check failed (jwt.ts WAKE_REFUSE_CODES), never token contents or ids.
    metric(env, 'refuse', 1, '401', [], 'token', place, verified ? verified.code : 'missing')
    return reject(401)
  }
  const gapHeader = request.headers.get(CONNECTOR_WAKE_GAP_HEADER) ?? ''
  const gap = /^\d{1,16}$/.test(gapHeader) ? Number(gapHeader) : Number.NaN
  if (Number.isSafeInteger(gap)) { metric(env, 'reconnect_gap', Math.min(gap, GAP_MAX_MS), '', [], '', place) }
  const headers = new Headers(request.headers)
  for (const name of [...headers.keys()]) {
    if (INTERNAL_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix)) || name === 'authorization') { headers.delete(name) }
  }
  headers.set(HOST_ID_HEADER, verified.hostId)
  headers.set(PLACE_HEADER, place)
  try {
    return await host(env, verified.hostId).fetch(new Request(request.url, { method: 'GET', headers }))
  } catch (error) {
    // The object could not be reached (a colo restarting, its link to the object broken, the
    // object overloaded or throwing). A 503 is a handled answer, not scriptThrewException: the
    // desktop backs off and redials either way (connector-wake-socket.ts treats any non-401 the
    // same). Logged without ids so Workers Logs keeps the reason.
    const e = error as { message?: unknown; retryable?: unknown; overloaded?: unknown }
    console.error('connector-wake: object forward failed', { message: String(e?.message ?? error), retryable: e?.retryable === true, overloaded: e?.overloaded === true, place })
    metric(env, 'upgrade', 1, 'object_unavailable', [], '', place)
    return reject(503, forwardRetryAfter())
  }
}

// Seconds. Spread, because the desktop waits exactly Retry-After (no jitter of its own), and a
// colo's whole set of desktops fails together.
const FORWARD_RETRY_AFTER_MIN_S = 5
const FORWARD_RETRY_AFTER_MAX_S = 30
function forwardRetryAfter(): number {
  return FORWARD_RETRY_AFTER_MIN_S + Math.floor(Math.random() * (FORWARD_RETRY_AFTER_MAX_S - FORWARD_RETRY_AFTER_MIN_S + 1))
}

async function wakeAll(env: Env, hosts: string[], kind: ConnectorWakeKind | undefined): Promise<ConnectorWakeAdminResponse> {
  const counts: ConnectorWakeAdminResponse = { delivered: 0, noSocket: 0, error: 0 }
  const unique = [...new Set(hosts)]
  let next = 0
  const worker = async () => {
    while (next < unique.length) {
      const hostId = unique[next++]
      const result: WakeResult = await host(env, hostId).wake(kind).catch(() => 'error' as const)
      if (result === 'delivered') { counts.delivered++ }
      else if (result === 'no_socket') { counts.noSocket++ }
      else { counts.error++ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(WAKE_FANOUT, unique.length) }, worker))
  return counts
}

async function handleAdminWake(env: Env, request: Request): Promise<Response> {
  if (request.method !== 'POST') { return reject(405) }
  const place = requestPlace(request)
  const verified = await verifyAdminRequest(env, request, 'wake')
  if (!verified) {
    metric(env, 'admin', 1, '401', [], '', place)
    return reject(401)
  }
  const body = ConnectorWakeAdminRequestSchema.safeParse(verified.body)
  if (!body.success) {
    metric(env, 'admin', 1, '400', [], '', place)
    return reject(400)
  }
  const counts = await wakeAll(env, body.data.hosts, body.data.kind)
  metric(env, 'admin', body.data.hosts.length, '200', [], '', place)
  if (counts.delivered) { metric(env, 'wake', counts.delivered, 'delivered', [], '', place) }
  if (counts.noSocket) { metric(env, 'wake', counts.noSocket, 'no_socket', [], '', place) }
  if (counts.error) { metric(env, 'wake', counts.error, 'error', [], '', place) }
  return Response.json(counts)
}

const ROUTE_LABELS = new Set(['/health', '/__health/object', CONNECTOR_WAKE_ADMIN_PATH, CONNECTOR_WAKE_PATH])
function routeLabel(request: Request): string {
  const path = new URL(request.url).pathname
  return ROUTE_LABELS.has(path) ? path : 'other'
}

async function route(request: Request, env: Env): Promise<Response> {
  // Fails every request (500) on a misconfigured deploy.
  wakeConfig(env)
  const url = new URL(request.url)
  if (url.pathname === '/health') { return Response.json({ ok: true }) }
  if (url.search) { return reject(400) }
  if (url.pathname === '/__health/object') { return objectHealth(env, request) }
  if (url.pathname === CONNECTOR_WAKE_ADMIN_PATH) { return handleAdminWake(env, request) }
  if (url.pathname === CONNECTOR_WAKE_PATH) { return handleUpgrade(env, request) }
  const spike = env.SPIKE_DEBUG === '1' ? /^\/__spike\/object\/([^/]+)$/.exec(url.pathname) : null
  if (spike) {
    let hostId = ''
    try {
      hostId = decodeURIComponent(spike[1])
    } catch {}
    if (!isHostId(hostId)) { return reject(400) }
    return Response.json({ worker: requestPlace(request), ...(await host(env, hostId).spikePlace()) })
  }
  return reject(404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (error) {
      // Still thrown (500, scriptThrewException, as before); logged first so Workers Logs keeps
      // the reason. A fixed route label, never the path (it can carry ids) or the query.
      console.error('connector-wake: request threw', { route: routeLabel(request), place: requestPlace(request), message: String((error as { message?: unknown })?.message ?? error) })
      throw error
    }
  }
} satisfies ExportedHandler<Env>
