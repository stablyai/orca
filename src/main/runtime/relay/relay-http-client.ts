import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { E2EEKeypair } from '../e2ee-keypair'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'
import { parseRelayRetryAfterMs } from '../../../shared/relay-retry-after-header'
import {
  RelayAssignAbortedError,
  RelayAssignRateLimitedError,
  relayAssignRateKey,
  sharedRelayAssignRateGate,
  type RelayAssignRateGate
} from './relay-assign-rate-gate'
import type { RelayRegion } from './relay-region-preference'

const RELAY_HTTP_REQUEST_DEADLINE_MS = 15_000
const RELAY_RETRY_AFTER_MAX_MS = 5 * 60_000

const RelayTokenResponseSchema = z
  .object({
    relayToken: z
      .string()
      .min(1)
      .max(8 * 1024),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

const AssignmentResponseSchema = z
  .object({
    v: z.literal(1),
    cellUrl: z.string().min(1).max(2048),
    assignmentEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lease: z
      .string()
      .min(1)
      .max(8 * 1024)
  })
  .strict()

export type RelayAuthorization = z.infer<typeof RelayTokenResponseSchema>
export type RelayAssignment = z.infer<typeof AssignmentResponseSchema>

export class RelayHttpError extends Error {
  constructor(
    readonly operation: 'token-exchange' | 'assignment',
    readonly statusCode: number,
    readonly retryAfterMs: number | null = null
  ) {
    super(`relay_${operation}_failed_${statusCode}`)
  }
}

// Distinct message so log censuses can tell a locally-enforced wait from a real
// director 429 — one server 429 would otherwise print several identical lines.
export class RelayAssignLocallyPacedError extends RelayHttpError {
  constructor(retryAfterMs: number) {
    super('assignment', 429, retryAfterMs)
    this.message = 'relay_assignment_locally_paced_429'
  }
}

function relayRetryAfterMs(value: string | null): number | null {
  return parseRelayRetryAfterMs(value, RELAY_RETRY_AFTER_MAX_MS)
}

export function shouldRetryRelayConnectionError(error: unknown): boolean {
  // A staleness abort means the caller was superseded — retrying it would
  // spend rate-gate slots on work whose owner is gone.
  if (error instanceof RelayAssignAbortedError) {
    return false
  }
  if (!(error instanceof RelayHttpError)) {
    return true
  }
  return (
    error.statusCode >= 500 ||
    error.statusCode === 408 ||
    error.statusCode === 425 ||
    error.statusCode === 429
  )
}

export function deriveRelayHostId(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('base64url').slice(0, 16)
}

function isAllowedRelayOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    const loopback =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    return (
      url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
    )
  } catch {
    return false
  }
}

export async function exchangeRelayAuthorization(input: {
  endpoint: string
  accessToken: string
  keypair: E2EEKeypair
  fetch?: typeof globalThis.fetch
  requestDeadlineMs?: number
}): Promise<RelayAuthorization> {
  const relayHostId = deriveRelayHostId(input.keypair.publicKey)
  const response = await (input.fetch ?? globalThis.fetch)(input.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': 'application/json'
    },
    // A blackholed request must settle so the coordinator can advance its bounded retry state.
    signal: AbortSignal.timeout(input.requestDeadlineMs ?? RELAY_HTTP_REQUEST_DEADLINE_MS),
    body: JSON.stringify({ relayHostId, hostPublicKeyB64: input.keypair.publicKeyB64 })
  })
  if (!response.ok) {
    const retryAfterMs = relayRetryAfterMs(response.headers.get('retry-after'))
    await cancelUnreadResponseBody(response)
    throw new RelayHttpError('token-exchange', response.status, retryAfterMs)
  }
  const parsed = RelayTokenResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new RelayHttpError('token-exchange', 502)
  }
  return parsed.data
}

type RelayAssignmentRequest = {
  directorUrl: string
  relayToken: string
  relayHostId: string
  reconnect?: boolean
  preferredRegion?: RelayRegion
  fetch?: typeof globalThis.fetch
  requestDeadlineMs?: number
  // Fencing for the throttle wait: a superseded caller aborts instead of assigning.
  isCurrent?: () => boolean
  assignRateGate?: RelayAssignRateGate
}

export async function requestRelayAssignment(
  input: RelayAssignmentRequest
): Promise<RelayAssignment> {
  if (!isAllowedRelayOrigin(input.directorUrl)) {
    throw new RelayHttpError('assignment', 400)
  }
  const gate = input.assignRateGate ?? sharedRelayAssignRateGate
  const rateKey = relayAssignRateKey(input.directorUrl, input.relayHostId)
  try {
    await gate.reserve(rateKey, input.isCurrent)
  } catch (error) {
    if (error instanceof RelayAssignRateLimitedError) {
      // Surface a long local wait as the 429 it stands in for, so the existing
      // schedulers pace with retryAfterMs instead of parking the caller inline.
      // Reachable only while a director Retry-After beyond the inline cap is
      // still in force — local booking alone never exceeds ~5.5s.
      throw new RelayAssignLocallyPacedError(error.retryAfterMs)
    }
    throw error
  }
  return await sendRelayAssignment(input, gate, rateKey)
}

// The field-fallback retries below are one logical attempt against one booked
// slot; re-entering the gate would stall rolled-back-director compatibility 5s.
async function sendRelayAssignment(
  input: RelayAssignmentRequest,
  gate: RelayAssignRateGate,
  rateKey: string
): Promise<RelayAssignment> {
  // A caller superseded after reserving — or between field-fallback retries —
  // must not spend more requests on an assignment nobody will consume.
  if (input.isCurrent && !input.isCurrent()) {
    throw new RelayAssignAbortedError()
  }
  const response = await (input.fetch ?? globalThis.fetch)(`${input.directorUrl}/v1/assign`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.relayToken}`,
      'content-type': 'application/json'
    },
    signal: AbortSignal.timeout(input.requestDeadlineMs ?? RELAY_HTTP_REQUEST_DEADLINE_MS),
    body: JSON.stringify({
      v: 1,
      relayHostId: input.relayHostId,
      ...(input.preferredRegion ? { preferredRegion: input.preferredRegion } : {}),
      // Declares likely reconnection so the director can verify and admit
      // through its bounded fast lane instead of the placement queue.
      ...(input.reconnect ? { reconnect: true } : {})
    })
  })
  if (!response.ok) {
    const retryAfterMs = relayRetryAfterMs(response.headers.get('retry-after'))
    if (retryAfterMs !== null) {
      gate.noteRetryAfter(rateKey, retryAfterMs)
    }
    await cancelUnreadResponseBody(response)
    if (input.preferredRegion && response.status === 400) {
      // A rolled-back director rejects the regional hint; preserve the
      // reconnect lane while retrying without only that field.
      return await sendRelayAssignment({ ...input, preferredRegion: undefined }, gate, rateKey)
    }
    if (input.reconnect && response.status === 400) {
      // A rolled-back director rejects unknown fields; retry once unhinted.
      return await sendRelayAssignment({ ...input, reconnect: false }, gate, rateKey)
    }
    throw new RelayHttpError('assignment', response.status, retryAfterMs)
  }
  const parsed = AssignmentResponseSchema.safeParse(await response.json())
  if (!parsed.success || !isAllowedRelayOrigin(parsed.data.cellUrl)) {
    throw new RelayHttpError('assignment', 502)
  }
  return parsed.data
}
