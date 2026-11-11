// One authenticated, schema-checked call to the Orca sandbox control plane, shared by every desktop
// client of it. The desktop holds only a short-lived Orca token; no provider credential.
import type { z } from 'zod'
import { HostedEntitlementDeniedError } from './hosted-environment-provider'
import { HostedSandboxErrorResponseSchema } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  EnvironmentProviderError,
  type EnvironmentProviderErrorCode
} from '../environment-providers/environment-provider-driver'

export type HostedSandboxControlPlaneClientOptions = {
  baseUrl: string
  /** Mints an Orca Cloud token with aud=orca-sandbox; never a provider credential. */
  getAccessToken: (signal?: AbortSignal) => Promise<string>
  fetch?: typeof fetch
  /** Per-call ceilings; create/resume/rollover include a VM boot and orcad start. */
  timeouts?: Partial<Record<'boot' | 'control', number>>
}

const DEFAULT_TIMEOUTS = { boot: 180_000, control: 60_000 }
const MAX_RESPONSE_BYTES = 256 * 1024

export type HostedSandboxRequest = <T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  schema: z.ZodType<T>,
  init: {
    body?: unknown
    kind: 'boot' | 'control'
    signal?: AbortSignal
    features?: readonly string[]
    headers?: Record<string, string>
  }
) => Promise<T>

/** One authenticated, schema-checked control-plane call; shared by every desktop client of it. */
export function createHostedSandboxRequest(
  options: HostedSandboxControlPlaneClientOptions
): HostedSandboxRequest {
  const base = parseBaseUrl(options.baseUrl)
  const doFetch = options.fetch ?? fetch
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }

  return async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    init: {
      body?: unknown
      kind: 'boot' | 'control'
      signal?: AbortSignal
      /** Per-call opt-ins on top of the features every call sends. */
      features?: readonly string[]
      /** Extra request headers (Idempotency-Key); the fixed ones below always win. */
      headers?: Record<string, string>
    }
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(timeouts[init.kind])
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
    let response: Response
    try {
      const token = await options.getAccessToken(signal)
      response = await doFetch(new URL(path, base), {
        method,
        headers: {
          ...init.headers,
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          // This client's schemas know the `archived` status.
          'x-orca-sandbox-features': [
            'archive',
            'idle-minutes',
            'wake-hints',
            ...(init.features ?? [])
          ].join(','),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        // Why: a redirect could forward the bearer token to another origin.
        redirect: 'manual',
        signal
      })
    } catch (error) {
      throw transportError(error, init.signal, timeoutSignal)
    }
    const payload = await readJson(response)
    if (!response.ok) {
      throw errorFromResponse(response.status, payload)
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new EnvironmentProviderError(
        'invalid_response',
        'Orca Cloud returned an unexpected response.'
      )
    }
    return parsed.data
  }
}

function parseBaseUrl(value: string): URL {
  const url = new URL(value.endsWith('/') ? value : `${value}/`)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Orca Cloud control plane must be HTTPS.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Orca Cloud control plane URL must not carry credentials, query or fragment.')
  }
  return url
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    return null
  }
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const STATUS_CODES: Record<string, EnvironmentProviderErrorCode> = {
  unauthorized: 'unauthorized',
  forbidden: 'unauthorized',
  not_found: 'not_found',
  conflict: 'conflict',
  invalid_request: 'invalid_request',
  invalid_json: 'invalid_request',
  billing_unavailable: 'unavailable',
  provider_unavailable: 'unavailable',
  not_configured: 'unavailable',
  internal_error: 'unavailable'
}

/**
 * A refusal the control plane answered with an error body. Routes newer than the shared code list
 * (e.g. the Codex broker's `broker_in_progress`) keep their own name here, so their clients can map it.
 */
export class HostedSandboxRefusalError extends EnvironmentProviderError {
  readonly serverError: string | null
  readonly httpStatus: number

  constructor(
    code: EnvironmentProviderErrorCode,
    message: string,
    reason: string | null,
    serverError: string | null,
    httpStatus: number
  ) {
    super(code, message, reason)
    this.name = 'HostedSandboxRefusalError'
    this.serverError = serverError
    this.httpStatus = httpStatus
  }
}

const SERVER_NAME = /^[a-z][a-z0-9_]{0,63}$/

/** The `error` name of any error body, if it looks like a name (never free text). */
function serverErrorName(payload: unknown): string | null {
  const error =
    typeof payload === 'object' && payload !== null && 'error' in payload ? payload.error : null
  return typeof error === 'string' && SERVER_NAME.test(error) ? error : null
}

function errorFromResponse(status: number, payload: unknown): EnvironmentProviderError {
  const parsed = HostedSandboxErrorResponseSchema.safeParse(payload)
  if (parsed.success && parsed.data.error === 'entitlement_denied') {
    return new HostedEntitlementDeniedError(
      'Orca Cloud refused the request (entitlement_denied).',
      parsed.data.reason ?? null
    )
  }
  if (parsed.success) {
    const code = STATUS_CODES[parsed.data.error] ?? 'unavailable'
    return new HostedSandboxRefusalError(
      code,
      `Orca Cloud refused the request (${parsed.data.error}).`,
      parsed.data.reason ?? null,
      parsed.data.error,
      status
    )
  }
  if (status >= 300 && status < 400) {
    return new EnvironmentProviderError('invalid_response', 'Orca Cloud answered with a redirect.')
  }
  return new HostedSandboxRefusalError(
    status === 401 || status === 403 ? 'unauthorized' : 'unavailable',
    `Orca Cloud request failed (HTTP ${status}).`,
    null,
    serverErrorName(payload),
    status
  )
}

function transportError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal
): EnvironmentProviderError {
  if (error instanceof EnvironmentProviderError) {
    return error
  }
  if (callerSignal?.aborted) {
    return new EnvironmentProviderError('aborted', 'Orca Cloud request was cancelled.')
  }
  if (timeoutSignal.aborted) {
    return new EnvironmentProviderError('timeout', 'Orca Cloud did not answer in time.')
  }
  return new EnvironmentProviderError('unavailable', 'Could not reach Orca Cloud.')
}
