// The director's client-facing endpoints, answered by the Worker from the host's own object (dark:
// reached only for DIRECTOR_HOSTNAME, see director-config.ts). Answers match what shipped desktops
// and phones parse with strict schemas: no extra keys, and no regionCorrection (shipped desktops
// treat its absence as "none"; their reports are accepted and ignored).
//   POST /v1/assign             relay JWT  -> {v, cellUrl, assignmentEpoch, lease}
//   POST /v1/resolve            resume     -> {v, cellUrl, assignmentEpoch, leaseExpiresAt}
//   GET  /v1/regions                       -> {v, regions: [{region, probeOrigins}]}
//   WS   /v1/connect/<host>     invite     -> relay-moved {v, cellUrl, assignmentEpoch}
// Lease: an opaque random string. Shipped desktops only check it is a string of 1..8192 chars and
// the edge never reads it (the legacy director's HS256 lease is verified by the legacy cells only, and
// these endpoints never hand out a legacy cell), so it needs no key.
import { z } from 'zod'
import { AssignmentRequestSchema, ResolveRequestSchema } from '../../../packages/relay-contract/src/director-messages'
import { RelayAuthSchema } from '../../../packages/relay-contract/src/credential-messages'
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import { ASSIGNMENT_LIMITS } from '../../../packages/relay-contract/src/assignment-invariants'
import { hashCredential } from '../../relay/src/credentials/credential-store'
import type { VerifyBody } from './admin'
import { b64url } from './bytes'
import { REGION_LOCATION_HINT, directorCellUrl, directorRegionCatalog, type DirectorConfig } from './director-config'
import type { DirectorAsk } from './director-assign'
import type { DirectorAssignAnswer, DirectorVerifyAnswer } from './host-relay-director'
import { HOST_ID, readBearer, type RelayJwtResult } from './jwt'

export type DirectorHost = {
  directorAssign(ask: DirectorAsk): Promise<DirectorAssignAnswer>
  directorVerify(body: VerifyBody, fallbackCellUrl: string): Promise<DirectorVerifyAnswer>
}

export type DirectorContext = {
  config: DirectorConfig
  // The host's object; the hint applies only when the object is first created.
  host(relayHostId: string, locationHint?: DurableObjectLocationHint): DirectorHost
  verifyToken(token: string): Promise<RelayJwtResult>
  // The per-source pre-auth limiter (preauth.ts).
  admit(kind: 'phone' | 'resolve'): Promise<boolean>
  // The client's country: the trusted ingress hop's, else the platform's (request.cf).
  country: string | undefined
  record(label: string): void
  now(): number
}

// Shipped desktops send regionCorrection reports; they are accepted whatever their shape and ignored.
const AssignBodySchema = AssignmentRequestSchema.extend({ regionCorrection: z.unknown().optional() })
const ASSIGN_BODY_MAX = 4 * 1024
const RETRY_AFTER_S = 5
const RESOLVE_LIMITED_RETRY_AFTER_S = 10
// Long enough for the legacy director to finish a move away, short enough to notice a backfill.
const ELSEWHERE_RETRY_AFTER_S = 30
const TOO_LARGE = Symbol('too_large')

function fail(status: number, error: string, retryAfter?: number): Response {
  return Response.json({ error }, { status, headers: retryAfter === undefined ? undefined : { 'retry-after': String(retryAfter) } })
}

export function opaqueLease(): string {
  return `edl1.${b64url(crypto.getRandomValues(new Uint8Array(24)))}`
}

// Reads at most `max` bytes of the body, whatever its declared length: null when it is longer.
async function readBounded(request: Request, max: number): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > max) { return null }
  if (!request.body) { return '' }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) { break }
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function readJson(request: Request, max: number): Promise<unknown> {
  const raw = await readBounded(request, max)
  if (raw === null) { return TOO_LARGE }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function handleDirector(request: Request, path: string, ctx: DirectorContext): Promise<Response> {
  const known = ['/v1/assign', '/v1/resolve', '/v1/regions'].includes(path) ? path.slice('/v1/'.length) : 'other'
  const route = path.startsWith('/v1/connect/') ? 'connect' : known
  const response = await routeDirector(request, path, ctx)
  ctx.record(`${route}:${response.status}`)
  return response
}

async function routeDirector(request: Request, path: string, ctx: DirectorContext): Promise<Response> {
  if (path === '/v1/regions' && request.method === 'GET') { return Response.json(directorRegionCatalog(ctx.config.hostname)) }
  if (path === '/v1/assign' && request.method === 'POST') { return assign(request, ctx) }
  if (path === '/v1/resolve' && request.method === 'POST') { return resolve(request, ctx) }
  const connect = /^\/v1\/connect\/([^/]+)$/.exec(path)
  if (connect) { return inviteMove(request, connect[1], ctx) }
  return new Response(null, { status: 404 })
}

async function assign(request: Request, ctx: DirectorContext): Promise<Response> {
  const token = readBearer(request.headers.get('authorization'))
  if (!token) { return fail(401, 'invalid_token') }
  const verified = await ctx.verifyToken(token)
  if (!verified.ok) {
    // No keys to judge the token (auth unreachable): a retry, never a bad credential.
    return verified.reason === 'keys_unavailable' ? fail(503, 'keys_unavailable', RETRY_AFTER_S) : fail(401, 'invalid_token')
  }
  const raw = await readJson(request, ASSIGN_BODY_MAX)
  if (raw === TOO_LARGE) { return fail(413, 'request_too_large') }
  const body = AssignBodySchema.safeParse(raw)
  if (!body.success) { return fail(400, 'invalid_request') }
  const { claims } = verified
  if (body.data.relayHostId !== claims.relayHostId) { return fail(403, 'host_identity_mismatch') }
  const cellUrl = directorCellUrl(ctx.config, ctx.country)
  const hint = body.data.preferredRegion ? REGION_LOCATION_HINT[body.data.preferredRegion] : undefined
  let answer: DirectorAssignAnswer
  try {
    answer = await ctx.host(claims.relayHostId, hint).directorAssign({ userId: claims.userId, relayHostId: claims.relayHostId, cellUrl })
  } catch {
    return fail(503, 'assignment_temporarily_unavailable', RETRY_AFTER_S)
  }
  if (answer.outcome === 'elsewhere') { return fail(503, 'assigned_elsewhere', ELSEWHERE_RETRY_AFTER_S) }
  if (answer.outcome !== 'assigned') { return fail(503, 'assignment_temporarily_unavailable', RETRY_AFTER_S) }
  return Response.json({ v: 1, cellUrl: answer.cellUrl, assignmentEpoch: answer.assignmentEpoch, lease: opaqueLease() })
}

async function resolve(request: Request, ctx: DirectorContext): Promise<Response> {
  if (!(await ctx.admit('resolve'))) { return fail(429, 'rate_limited', RESOLVE_LIMITED_RETRY_AFTER_S) }
  const raw = await readJson(request, RELAY_PROTOCOL_LIMITS.maxHttpBodyBytes)
  if (raw === TOO_LARGE) { return fail(413, 'request_too_large') }
  const body = ResolveRequestSchema.safeParse(raw)
  if (!body.success) { return fail(400, 'invalid_request') }
  const { relayHostId, resumeToken } = body.data
  let answer: DirectorVerifyAnswer
  try {
    answer = await ctx.host(relayHostId).directorVerify({ relayHostId, kind: 'resume', tokenHash: hashCredential(resumeToken) }, ctx.config.edgeUrl)
  } catch {
    return fail(503, 'assignment_temporarily_unavailable', RETRY_AFTER_S)
  }
  if (answer.outcome !== 'verified') { return fail(401, 'invalid_credential') }
  return Response.json({
    v: 1,
    cellUrl: answer.cellUrl,
    assignmentEpoch: answer.assignmentEpoch,
    leaseExpiresAt: ctx.now() + ASSIGNMENT_LIMITS.activityLeaseMs
  })
}

// ---------------- invite move (WS /v1/connect/<host> on the director hostname) ----------------

export type InviteAnswer = { frame: string; code: number; reason: string }
const FIRST_FRAME_MAX = 4 * 1024
// The frame's `type` is checked here; the rest is the contract's strict RelayAuth.
const AuthFrameSchema = z.looseObject({ type: z.literal('relay-auth') })

function withoutType({ type: _type, ...rest }: { type: string }): Record<string, unknown> {
  return rest
}

function refusal(code: number, reason: string): InviteAnswer {
  return { frame: JSON.stringify({ type: 'relay-hello', ok: false, code }), code, reason }
}

// The phone's first frame: `relay-auth` carrying its invite. A valid invite is answered with
// `relay-moved` naming the host's cell (the phone then dials it); anything else as the legacy
// director does.
export async function answerInviteFrame(data: unknown, relayHostId: string, host: DirectorHost, fallbackCellUrl: string): Promise<InviteAnswer> {
  let parsed: unknown = null
  if (typeof data === 'string' && data.length <= FIRST_FRAME_MAX) {
    try {
      parsed = JSON.parse(data)
    } catch {
      parsed = null
    }
  }
  const frame = AuthFrameSchema.safeParse(parsed)
  const auth = frame.success ? RelayAuthSchema.safeParse(withoutType(frame.data)) : null
  if (!auth?.success) { return refusal(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid relay auth') }
  let answer: DirectorVerifyAnswer
  try {
    answer = await host.directorVerify({ relayHostId, kind: 'invite', tokenHash: hashCredential(auth.data.credential) }, fallbackCellUrl)
  } catch {
    return refusal(RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'relay temporarily unavailable')
  }
  if (answer.outcome !== 'verified') { return refusal(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid invite') }
  return {
    frame: JSON.stringify({ type: 'relay-moved', v: 1, cellUrl: answer.cellUrl, assignmentEpoch: answer.assignmentEpoch }),
    code: RELAY_CLOSE_CODE.DRAINING,
    reason: 'connect to assigned cell'
  }
}

async function inviteMove(request: Request, relayHostId: string, ctx: DirectorContext): Promise<Response> {
  // Same order and answers as the edge's own /v1/connect.
  if (!(await ctx.admit('phone'))) { return new Response(null, { status: 429 }) }
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') { return new Response(null, { status: 426 }) }
  if (!HOST_ID.test(relayHostId)) { return new Response(null, { status: 429 }) }
  const [client, server] = Object.values(new WebSocketPair())
  server.accept()
  let answered = false
  const timer = setTimeout(() => {
    answered = true
    try {
      server.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'first frame timeout')
    } catch {}
  }, RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs)
  server.addEventListener('message', (event) => {
    if (answered) { return }
    answered = true
    clearTimeout(timer)
    void answerInviteFrame(event.data, relayHostId, ctx.host(relayHostId), ctx.config.edgeUrl).then((answer) => {
      try {
        server.send(answer.frame)
        server.close(answer.code, answer.reason)
      } catch {}
    })
  })
  server.addEventListener('close', () => clearTimeout(timer))
  return new Response(null, { status: 101, webSocket: client })
}
