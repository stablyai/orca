// HTTPS client for the Orca sandbox control plane. The desktop holds only a short-lived Orca token;
// the provider credential never leaves the control plane.
import type { z } from 'zod'
import {
  HostedSandboxErrorResponseSchema,
  HostedSandboxListResponseSchema,
  HostedSandboxReadyResponseSchema,
  HostedSandboxStatusResponseSchema,
  type HostedSandboxCreateRequest,
  type HostedSandboxReadyResponse,
  type HostedSandboxView
} from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  EnvironmentProviderError,
  type EnvironmentProviderErrorCode
} from '../environment-providers/environment-provider-driver'

export type HostedSandboxControlPlaneClient = {
  create(
    body: HostedSandboxCreateRequest,
    signal?: AbortSignal
  ): Promise<HostedSandboxReadyResponse>
  get(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxView>
  list(signal?: AbortSignal): Promise<HostedSandboxView[]>
  suspend(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxView>
  resume(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxReadyResponse>
  renewLease(sandboxId: string, extendMs: number, signal?: AbortSignal): Promise<HostedSandboxView>
  rollover(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxReadyResponse>
  destroy(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxView>
}

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

export function createHostedSandboxControlPlaneClient(
  options: HostedSandboxControlPlaneClientOptions
): HostedSandboxControlPlaneClient {
  const base = parseBaseUrl(options.baseUrl)
  const doFetch = options.fetch ?? fetch
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }

  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    init: { body?: unknown; kind: 'boot' | 'control'; signal?: AbortSignal }
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(timeouts[init.kind])
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
    let response: Response
    try {
      const token = await options.getAccessToken(signal)
      response = await doFetch(new URL(path, base), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
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

  const sandboxPath = (id: string, suffix = ''): string =>
    `v1/sandboxes/${encodeURIComponent(id)}${suffix}`

  return {
    create: (body, signal) =>
      call('POST', 'v1/sandboxes', HostedSandboxReadyResponseSchema, {
        body,
        kind: 'boot',
        signal
      }),
    get: async (id, signal) =>
      (
        await call('GET', sandboxPath(id), HostedSandboxStatusResponseSchema, {
          kind: 'control',
          signal
        })
      ).sandbox,
    list: async (signal) =>
      (
        await call('GET', 'v1/sandboxes', HostedSandboxListResponseSchema, {
          kind: 'control',
          signal
        })
      ).sandboxes,
    suspend: async (id, signal) =>
      (
        await call('POST', sandboxPath(id, '/suspend'), HostedSandboxStatusResponseSchema, {
          kind: 'control',
          signal
        })
      ).sandbox,
    resume: (id, signal) =>
      call('POST', sandboxPath(id, '/resume'), HostedSandboxReadyResponseSchema, {
        kind: 'boot',
        signal
      }),
    renewLease: async (id, extendMs, signal) =>
      (
        await call('POST', sandboxPath(id, '/lease'), HostedSandboxStatusResponseSchema, {
          body: { extendMs },
          kind: 'control',
          signal
        })
      ).sandbox,
    rollover: (id, signal) =>
      call('POST', sandboxPath(id, '/rollover'), HostedSandboxReadyResponseSchema, {
        kind: 'boot',
        signal
      }),
    destroy: async (id, signal) =>
      (
        await call('DELETE', sandboxPath(id), HostedSandboxStatusResponseSchema, {
          kind: 'control',
          signal
        })
      ).sandbox
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
  entitlement_denied: 'entitlement_denied',
  invalid_request: 'invalid_request',
  invalid_json: 'invalid_request',
  billing_unavailable: 'unavailable',
  provider_unavailable: 'unavailable',
  not_configured: 'unavailable',
  internal_error: 'unavailable'
}

function errorFromResponse(status: number, payload: unknown): EnvironmentProviderError {
  const parsed = HostedSandboxErrorResponseSchema.safeParse(payload)
  if (parsed.success) {
    const code = STATUS_CODES[parsed.data.error] ?? 'unavailable'
    return new EnvironmentProviderError(
      code,
      `Orca Cloud refused the request (${parsed.data.error}).`,
      parsed.data.reason ?? null
    )
  }
  if (status >= 300 && status < 400) {
    return new EnvironmentProviderError('invalid_response', 'Orca Cloud answered with a redirect.')
  }
  return new EnvironmentProviderError(
    status === 401 || status === 403 ? 'unauthorized' : 'unavailable',
    `Orca Cloud request failed (HTTP ${status}).`
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
