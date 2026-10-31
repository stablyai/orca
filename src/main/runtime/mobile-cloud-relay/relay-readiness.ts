import { RelayHttpError } from './relay-http-client'
import { RelayHostProofClockSkewError } from './relay-host-proof'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'

// Lowercase reason tokens must form valid relay_<reason> mint-failure codes.
export type RelayUnavailableReason =
  | 'signed_out'
  | 'not_entitled'
  | 'identity_changed'
  | 'rate_limited'
  | 'tls_untrusted'
  | 'connect_timeout'
  | 'network'
  | 'clock_skew'
  | 'control_not_active'
  | `director_${'token_exchange' | 'assignment'}_${number}`
  | `control_${string}`

export type RelayUnavailable = {
  reason: RelayUnavailableReason
  retryAt: number | null
  clockOffsetMs?: number
}

const TLS_TRUST_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE'
])
const TIMEOUT_ERROR_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])
const RELAY_CONTROL_MESSAGE = /^relay_(control_[a-z0-9_]{1,60})$/

function errorCode(error: unknown): string | null {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : null
}

// undici wraps the socket error as `TypeError('fetch failed', { cause })`.
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current = error
  while (current !== undefined && current !== null && chain.length < 4) {
    chain.push(current)
    current = current instanceof Error ? current.cause : undefined
  }
  return chain
}

export function relayUnavailableReasonFor(error: unknown): RelayUnavailableReason {
  if (error instanceof RelayHostProofClockSkewError) {
    return 'clock_skew'
  }
  if (error instanceof RelayHttpError) {
    return error.statusCode === 429
      ? 'rate_limited'
      : `director_${error.operation === 'token-exchange' ? 'token_exchange' : 'assignment'}_${error.statusCode}`
  }
  for (const link of errorChain(error)) {
    const code = errorCode(link)
    if (code && (TLS_TRUST_ERROR_CODES.has(code) || code.startsWith('CERT_'))) {
      return 'tls_untrusted'
    }
    if (code && TIMEOUT_ERROR_CODES.has(code)) {
      return 'connect_timeout'
    }
  }
  const message = error instanceof Error ? RELAY_CONTROL_MESSAGE.exec(error.message) : null
  if (message?.[1] === 'control_closed_4429') {
    return 'rate_limited'
  }
  return message ? `control_${message[1].slice('control_'.length)}` : 'network'
}

export function relayUnavailableFor(error: unknown): Omit<RelayUnavailable, 'retryAt'> {
  return {
    reason: relayUnavailableReasonFor(error),
    ...(error instanceof RelayHostProofClockSkewError ? { clockOffsetMs: error.clockOffsetMs } : {})
  }
}

const RATE_LIMIT_FLOOR_BASE_MS = 5_000
const RATE_LIMIT_FLOOR_MAX_MS = 30_000

// Lone 4429 retries immediately; limit-coded/repeated 4429 failures back off 5–30s to escape rate limiting.
export function relayRetryFloorMs(error: unknown, priorAttempts: number): number {
  if (error instanceof RelayHttpError) {
    return error.retryAfterMs ?? 0
  }
  const reason = relayUnavailableReasonFor(error)
  const limitCoded = reason.startsWith('control_error_') && /limit|rate/.test(reason)
  if (!limitCoded && !(reason === 'rate_limited' && priorAttempts > 0)) {
    return 0
  }
  const doublings = Math.max(0, limitCoded ? priorAttempts : priorAttempts - 1)
  return Math.min(RATE_LIMIT_FLOOR_MAX_MS, RATE_LIMIT_FLOOR_BASE_MS * 2 ** doublings)
}

// Deadline/fence releases only this waiter, never shared reconnect work.
export class RelayReadinessWaiters {
  private readonly releases = new Set<() => void>()

  /** True when work settles first; false on deadline or release. */
  async until(work: Promise<unknown>, deadline: number): Promise<boolean> {
    const controller = new AbortController()
    const released = new Error('Relay readiness wait released')
    const release = (): void => controller.abort(released)
    const timer = setTimeout(release, Math.max(0, deadline - Date.now()))
    this.releases.add(release)
    try {
      await waitForPromiseWithSignal(work, controller.signal)
      return true
    } catch (error) {
      if (error === released) {
        return false
      }
      throw error
    } finally {
      clearTimeout(timer)
      this.releases.delete(release)
    }
  }

  releaseAll(): void {
    for (const release of this.releases) {
      release()
    }
  }
}

export class RelayUnavailableError extends Error {
  readonly code: string
  readonly clockOffsetMs?: number

  constructor(readonly unavailable: RelayUnavailable) {
    super(`relay_${unavailable.reason}`)
    this.code = this.message
    this.clockOffsetMs = unavailable.clockOffsetMs
  }
}
