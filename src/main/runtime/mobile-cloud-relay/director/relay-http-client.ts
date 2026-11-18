import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { E2EEKeypair } from '../../rpc/server/pairing/e2ee-keypair'
import { cancelUnreadResponseBody } from '../../../lib/unread-response-body'
import { parseRetryAfterHeaderMs } from '../../../../shared/network/retry-after-header'
import {
  RelayAssignAbortedError,
  RelayAssignRateLimitedError,
  relayAssignRateKey,
  sharedRelayAssignRateGate,
  type RelayAssignRateGate
} from './relay-assign-rate-gate'
import type { RelayRegion } from '../region-selection/relay-region-probe'
import {
  RelayRegionCorrectionResponseSchema,
  type RelayRegionCorrectionRequest
} from '../region-selection/relay-region-correction-protocol'

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
      .max(8 * 1024),
    regionCorrection: RelayRegionCorrectionResponseSchema.optional().catch(undefined),
    // Validated per entry in relayAlternateCellUrls so a bad entry never rejects the assignment.
    alternateCellUrls: z.unknown().optional()
  })
  .strict()

// Mirror relay-contract RELAY_HOST_CAPABILITY_ORIGIN_ALTERNATES. A header, not a body key, so an
// older director ignores it; a director sends alternateCellUrls only when it sees this.
export const RELAY_ASSIGN_CAPABILITY_HEADERS = {
  'x-orca-host-capabilities': 'origin-alternates-v1'
} as const

// Mirror relay-contract AssignmentResponse.alternateCellUrls: at most two origins.
const RELAY_MAX_ALTERNATE_CELL_URLS = 2

export type RelayAuthorization = z.infer<typeof RelayTokenResponseSchema>
export type RelayAssignment = Omit<
  z.infer<typeof AssignmentResponseSchema>,
  'alternateCellUrls'
> & {
  // Other origins reaching the same host session as cellUrl, in preference order; never cellUrl.
  // RelayControlOrigin resumes the control on these when the cellUrl path stalls (desktop only).
  alternateCellUrls?: string[]
}

export class RelayHttpError extends Error {
  constructor(
    readonly operation: 'token-exchange' | 'assignment',
    readonly statusCode: number,
    readonly retryAfterMs: number | null = null
  ) {
    super(`relay_${operation}_failed_${statusCode}`)
  }
}

// Distinguish local pacing from director 429s so one refusal does not look like many.
export class RelayAssignLocallyPacedError extends RelayHttpError {
  constructor(retryAfterMs: number) {
    super('assignment', 429, retryAfterMs)
    this.message = 'relay_assignment_locally_paced_429'
  }
}

function relayRetryAfterMs(value: string | null): number | null {
  return parseRetryAfterHeaderMs(value, RELAY_RETRY_AFTER_MAX_MS)
}

export function shouldRetryRelayConnectionError(error: unknown): boolean {
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

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value
  } catch {
    return false
  }
}

// Drop entries that are invalid, duplicate, or equal to cellUrl instead of failing the answer.
function relayAlternateCellUrls(value: unknown, cellUrl: string): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const kept: string[] = []
  for (const entry of value.slice(0, RELAY_MAX_ALTERNATE_CELL_URLS)) {
    if (
      typeof entry === 'string' &&
      entry.length <= 2048 &&
      entry !== cellUrl &&
      !kept.includes(entry) &&
      isCanonicalHttpsOrigin(entry)
    ) {
      kept.push(entry)
    }
  }
  return kept.length > 0 ? kept : undefined
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
  regionCorrection?: RelayRegionCorrectionRequest
  fetch?: typeof globalThis.fetch
  requestDeadlineMs?: number
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
      // Expose over-budget Retry-After as paced 429 so schedulers retry without parking pairing IPC.
      throw new RelayAssignLocallyPacedError(error.retryAfterMs)
    }
    throw error
  }
  return await sendRelayAssignment(input, gate, rateKey)
}

// Compatibility field retries are one logical attempt/slot; rebooking would add 5s per fallback.
async function sendRelayAssignment(
  input: RelayAssignmentRequest,
  gate: RelayAssignRateGate,
  rateKey: string
): Promise<RelayAssignment> {
  // Superseded callers cannot assign after booking or between compatibility retries.
  if (input.isCurrent && !input.isCurrent()) {
    throw new RelayAssignAbortedError()
  }
  const response = await (input.fetch ?? globalThis.fetch)(`${input.directorUrl}/v1/assign`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.relayToken}`,
      'content-type': 'application/json',
      ...RELAY_ASSIGN_CAPABILITY_HEADERS
    },
    signal: AbortSignal.timeout(input.requestDeadlineMs ?? RELAY_HTTP_REQUEST_DEADLINE_MS),
    body: JSON.stringify({
      v: 1,
      relayHostId: input.relayHostId,
      ...(input.regionCorrection ? { regionCorrection: input.regionCorrection } : {}),
      ...(input.preferredRegion ? { preferredRegion: input.preferredRegion } : {}),
      ...(input.reconnect ? { reconnect: true } : {})
    })
  })
  if (!response.ok) {
    const retryAfterMs = relayRetryAfterMs(response.headers.get('retry-after'))
    if (retryAfterMs !== null) {
      gate.noteRetryAfter(rateKey, retryAfterMs)
    }
    await cancelUnreadResponseBody(response)
    if (input.regionCorrection && response.status === 400) {
      return await sendRelayAssignment({ ...input, regionCorrection: undefined }, gate, rateKey)
    }
    if (input.preferredRegion && response.status === 400) {
      return await sendRelayAssignment({ ...input, preferredRegion: undefined }, gate, rateKey)
    }
    if (input.reconnect && response.status === 400) {
      return await sendRelayAssignment({ ...input, reconnect: false }, gate, rateKey)
    }
    throw new RelayHttpError('assignment', response.status, retryAfterMs)
  }
  const parsed = AssignmentResponseSchema.safeParse(await response.json())
  if (!parsed.success || !isAllowedRelayOrigin(parsed.data.cellUrl)) {
    throw new RelayHttpError('assignment', 502)
  }
  const { alternateCellUrls: rawAlternateCellUrls, ...assignment } = parsed.data
  const alternateCellUrls = relayAlternateCellUrls(rawAlternateCellUrls, assignment.cellUrl)
  return alternateCellUrls ? { ...assignment, alternateCellUrls } : assignment
}
