import { setTimeout as delay } from 'node:timers/promises'
import { startSpan, type ActiveSpan } from '../observability/tracer'

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET'
])
const DIAGNOSTIC_CODES = new Set([
  ...TRANSIENT_CODES,
  'ENOTFOUND',
  'ECONNABORTED',
  'EPROTO',
  'UND_ERR_DESTROYED',
  'UND_ERR_CLOSED',
  'EMFILE',
  'ENFILE',
  'ENOBUFS',
  'EADDRNOTAVAIL',
  'EACCES',
  'EPERM',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID'
])

function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function transportFailure(error: unknown): { codes: string[]; retryable: boolean } {
  const pending: { error: unknown; depth: number }[] = [{ error, depth: 0 }]
  const seen = new Set<unknown>()
  const codes = new Set<string>()
  let retryable = true
  while (pending.length && seen.size < 16) {
    const next = pending.shift()
    if (!next || !(next.error instanceof Error) || seen.has(next.error) || next.depth > 6) {
      retryable = false
      continue
    }
    const current = next.error
    seen.add(current)
    const code = 'code' in current ? current.code : undefined
    if (typeof code === 'string') {
      if (DIAGNOSTIC_CODES.has(code)) {
        codes.add(code)
      }
      if (!TRANSIENT_CODES.has(code)) {
        retryable = false
      }
    }
    if (isCancellation(current)) {
      retryable = false
    }
    const children: unknown[] = []
    if (current.cause !== undefined) {
      children.push(current.cause)
    }
    // Generated SDK errors retain native failures under raw rather than cause.
    if ('raw' in current && current.raw !== undefined) {
      children.push(current.raw)
    }
    if (current instanceof AggregateError) {
      if (current.errors.length > 16) {
        retryable = false
      }
      children.push(...current.errors.slice(0, 16))
    }
    if (children.length === 0 && typeof code !== 'string') {
      retryable = false
    }
    for (const child of children) {
      if (pending.length >= 16) {
        retryable = false
        break
      }
      pending.push({ error: child, depth: next.depth + 1 })
    }
  }
  return { codes: [...codes], retryable: retryable && pending.length === 0 && codes.size > 0 }
}

export function linearTransportErrorCodes(error: unknown): string[] {
  return transportFailure(error).codes
}

export async function recoverLinearQuery<T>(
  query: unknown,
  request: () => Promise<T>,
  options: RequestInit
): Promise<T> {
  const started = performance.now()
  const signal = options.signal
  // SDK options can override the generated body/method, so only retry documents we own.
  const operation = () =>
    Object.hasOwn(options, 'body') || Object.hasOwn(options, 'method') || typeof query !== 'string'
      ? 'unknown'
      : /^\s*(?:query\b|\{)/.test(query)
        ? 'query'
        : /^\s*mutation\b/.test(query)
          ? 'mutation'
          : 'unknown'
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    const kind = operation()
    const attemptStarted = performance.now()
    let span: ActiveSpan | undefined
    try {
      span = startSpan('linear.request', { kind: 'client' })
    } catch {}
    const finish = (outcome: 'success' | 'failure' | 'cancelled', codes: string[]): void => {
      try {
        const now = performance.now()
        span?.setAttribute('linear.operation', kind)
        span?.setAttribute('linear.transport', 'native-fetch')
        span?.setAttribute('linear.attempts', attempt)
        span?.setAttribute('linear.attemptMs', Math.max(0, now - attemptStarted))
        span?.setAttribute('linear.elapsedMs', Math.max(0, now - started))
        span?.setAttribute('linear.codes', codes)
        if (outcome === 'success') {
          span?.end()
        } else if (outcome === 'cancelled') {
          span?.interrupt('linear_request_cancelled')
        } else {
          span?.fail('linear_request_failed')
        }
      } catch {}
    }
    try {
      const result = await request()
      signal?.throwIfAborted()
      finish('success', [])
      return result
    } catch (error) {
      if (signal?.aborted) {
        finish('cancelled', [])
        signal.throwIfAborted()
      }
      const failure = transportFailure(error)
      const cancelled = isCancellation(error)
      finish(cancelled ? 'cancelled' : 'failure', failure.codes)
      signal?.throwIfAborted()
      const wait = 100 * attempt
      if (
        kind !== 'query' ||
        !failure.retryable ||
        attempt === 3 ||
        performance.now() - started + wait >= 1000
      ) {
        throw error
      }
      try {
        await delay(wait, undefined, { signal: signal ?? undefined })
      } catch (waitError) {
        signal?.throwIfAborted()
        throw waitError
      }
      signal?.throwIfAborted()
      if (operation() !== 'query' || performance.now() - started >= 1000) {
        throw error
      }
    }
  }
}
