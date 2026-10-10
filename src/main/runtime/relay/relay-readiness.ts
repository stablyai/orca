import { RelayHttpError } from './relay-http-client'

// Why the last reconcile could not produce a live broker. Every value is a
// lowercase token so `relay_<reason>` stays a valid mint failure code.
export type RelayUnavailableReason =
  | 'signed_out'
  | 'not_entitled'
  | 'identity_changed'
  | 'rate_limited'
  | 'tls_untrusted'
  | 'connect_timeout'
  | 'network'
  | 'control_not_active'
  | `director_${'token_exchange' | 'assignment'}_${number}`
  // A relay-coded error message with its `relay_` prefix removed.
  | `control_${string}`

export type RelayUnavailable = { reason: RelayUnavailableReason; retryAt: number | null }

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

// Bounds a readiness wait by its caller's deadline and lets a fence release it,
// without cancelling the shared reconnect work other callers still need.
export class RelayReadinessWaiters {
  private readonly releases = new Set<() => void>()

  // Resolves true when `work` settles first, false at the deadline or on release.
  async until(work: Promise<unknown>, deadline: number): Promise<boolean> {
    let release = (): void => {}
    const released = new Promise<false>((resolve) => {
      release = () => resolve(false)
    })
    const timer = setTimeout(release, Math.max(0, deadline - Date.now()))
    this.releases.add(release)
    try {
      return await Promise.race([work.then(() => true), released])
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

// Carries the readiness reason as a `relay_*` code that mint failure reporting forwards as-is.
export class RelayUnavailableError extends Error {
  readonly code: string

  constructor(readonly unavailable: RelayUnavailable) {
    super(`relay_${unavailable.reason}`)
    this.code = this.message
  }
}
