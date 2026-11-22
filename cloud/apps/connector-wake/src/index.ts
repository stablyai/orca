// Connector wake Worker: a stateless router in front of one ConnectorHost object per host.
//   GET  /v1/connector/wake  desktop upgrade (wake token, checked here only)
//   POST /__admin/wake       connector publisher (admin.ts)
//   GET  /__health/object    alerts deep probe (health.ts)
import {
  CONNECTOR_WAKE_ADMIN_PATH,
  CONNECTOR_WAKE_CLOSE_CODE,
  CONNECTOR_WAKE_GAP_HEADER,
  CONNECTOR_WAKE_PATH,
  ConnectorWakeAdminRequestSchema,
  type ConnectorWakeAdminResponse
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
    metric(env, 'refuse', 1, '401', [], 'token', place)
    return reject(401)
  }
  const gap = Number(request.headers.get(CONNECTOR_WAKE_GAP_HEADER) ?? Number.NaN)
  if (Number.isSafeInteger(gap) && gap >= 0) { metric(env, 'reconnect_gap', Math.min(gap, GAP_MAX_MS), '', [], '', place) }
  const headers = new Headers(request.headers)
  for (const name of [...headers.keys()]) {
    if (INTERNAL_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix)) || name === 'authorization') { headers.delete(name) }
  }
  headers.set(HOST_ID_HEADER, verified.hostId)
  headers.set(PLACE_HEADER, place)
  return host(env, verified.hostId).fetch(new Request(request.url, { method: 'GET', headers }))
}

async function wakeAll(env: Env, hosts: string[]): Promise<ConnectorWakeAdminResponse> {
  const counts: ConnectorWakeAdminResponse = { delivered: 0, noSocket: 0, error: 0 }
  const unique = [...new Set(hosts)]
  let next = 0
  const worker = async () => {
    while (next < unique.length) {
      const hostId = unique[next++]
      const result: WakeResult = await host(env, hostId).wake().catch(() => 'error' as const)
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
  const counts = await wakeAll(env, body.data.hosts)
  metric(env, 'admin', body.data.hosts.length, '200', [], '', place)
  if (counts.delivered) { metric(env, 'wake', counts.delivered, 'delivered', [], '', place) }
  if (counts.noSocket) { metric(env, 'wake', counts.noSocket, 'no_socket', [], '', place) }
  if (counts.error) { metric(env, 'wake', counts.error, 'error', [], '', place) }
  return Response.json(counts)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      const hostId = decodeURIComponent(spike[1])
      if (!isHostId(hostId)) { return reject(400) }
      return Response.json({ worker: requestPlace(request), ...(await host(env, hostId).spikePlace()) })
    }
    return reject(404)
  }
} satisfies ExportedHandler<Env>
