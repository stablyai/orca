// HTTPS client for org environments on the Orca sandbox control plane (/v1/environments). Same
// bearer as /v1/sandboxes; the desktop holds only a short-lived Orca token.
import type { z } from 'zod'
import {
  HostedEnvironmentBuildResponseSchema,
  HostedEnvironmentDeletedResponseSchema,
  HostedEnvironmentDetailResponseSchema,
  HostedEnvironmentListResponseSchema,
  HostedEnvironmentResponseSchema,
  HostedEnvironmentStalenessResponseSchema,
  isHostedEnvironmentBuildId,
  isHostedEnvironmentId,
  type HostedEnvironmentBuildView,
  type HostedEnvironmentCreateInput,
  type HostedEnvironmentDetailResponse,
  type HostedEnvironmentListResponse,
  type HostedEnvironmentStaleness,
  type HostedEnvironmentUpdateInput,
  type HostedEnvironmentView
} from '../../../shared/hosted-sandbox/hosted-environment-wire'
import {
  errorFromResponse,
  HostedEnvironmentRequestError,
  parseBaseUrl,
  readJson,
  transportError
} from './hosted-environment-http'

export {
  HostedEnvironmentRequestError,
  HostedEnvironmentUserError
} from './hosted-environment-http'

export type HostedEnvironmentClient = {
  list(signal?: AbortSignal): Promise<HostedEnvironmentListResponse>
  get(envId: string, signal?: AbortSignal): Promise<HostedEnvironmentDetailResponse>
  create(input: HostedEnvironmentCreateInput, signal?: AbortSignal): Promise<HostedEnvironmentView>
  update(
    envId: string,
    patch: HostedEnvironmentUpdateInput,
    signal?: AbortSignal
  ): Promise<HostedEnvironmentView>
  remove(envId: string, signal?: AbortSignal): Promise<{ deleted: true }>
  startBuild(envId: string, signal?: AbortSignal): Promise<HostedEnvironmentBuildView>
  getBuild(
    envId: string,
    buildId: string,
    signal?: AbortSignal
  ): Promise<HostedEnvironmentBuildView>
  cancelBuild(
    envId: string,
    buildId: string,
    signal?: AbortSignal
  ): Promise<HostedEnvironmentBuildView>
  activateBuild(
    envId: string,
    buildId: string,
    signal?: AbortSignal
  ): Promise<HostedEnvironmentView>
  staleness(
    envId: string,
    refresh?: boolean,
    signal?: AbortSignal
  ): Promise<HostedEnvironmentStaleness>
  /** Opens the ndjson event stream; the caller owns the body and its cancellation via `signal`. */
  openBuildEvents(
    envId: string,
    buildId: string,
    signal: AbortSignal
  ): Promise<ReadableStream<Uint8Array>>
}

export type HostedEnvironmentClientOptions = {
  baseUrl: string
  getAccessToken: (signal?: AbortSignal) => Promise<string>
  fetch?: (input: URL, init: RequestInit) => Promise<Response>
  /** Per-call ceiling for JSON routes; the event stream has none (the watcher runs an idle timer). */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

export function createHostedEnvironmentClient(
  options: HostedEnvironmentClientOptions
): HostedEnvironmentClient {
  const base = parseBaseUrl(options.baseUrl)
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function send(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    init: { body?: unknown; signal?: AbortSignal; accept?: string; timeout?: AbortSignal }
  ): Promise<Response> {
    const signals = [init.signal, init.timeout].filter((s): s is AbortSignal => s !== undefined)
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    try {
      const token = await options.getAccessToken(signal)
      return await doFetch(new URL(path, base), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: init.accept ?? 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        // Why: a redirect could forward the bearer token to another origin.
        redirect: 'manual',
        signal
      })
    } catch (error) {
      throw transportError(error, init.signal, init.timeout)
    }
  }

  async function call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    init: { body?: unknown; signal?: AbortSignal } = {}
  ): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await send(method, path, { ...init, timeout })
    let payload: unknown
    try {
      payload = await readJson(response)
    } catch (error) {
      throw transportError(error, init.signal, timeout)
    }
    if (!response.ok) {
      throw errorFromResponse(response.status, payload)
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new HostedEnvironmentRequestError(
        'invalid_response',
        null,
        'Orca Cloud returned an unexpected response.',
        response.status
      )
    }
    return parsed.data
  }

  return {
    list: (signal) =>
      call('GET', 'v1/environments', HostedEnvironmentListResponseSchema, { signal }),
    get: async (envId, signal) =>
      call('GET', envPath(envId), HostedEnvironmentDetailResponseSchema, { signal }),
    create: async (input, signal) =>
      (
        await call('POST', 'v1/environments', HostedEnvironmentResponseSchema, {
          body: input,
          signal
        })
      ).environment,
    update: async (envId, patch, signal) =>
      (
        await call('PATCH', envPath(envId), HostedEnvironmentResponseSchema, {
          body: patch,
          signal
        })
      ).environment,
    remove: async (envId, signal) => {
      await call('DELETE', envPath(envId), HostedEnvironmentDeletedResponseSchema, { signal })
      return { deleted: true }
    },
    startBuild: async (envId, signal) =>
      (
        await call('POST', envPath(envId, '/builds'), HostedEnvironmentBuildResponseSchema, {
          signal
        })
      ).build,
    getBuild: async (envId, buildId, signal) =>
      (
        await call('GET', buildPath(envId, buildId), HostedEnvironmentBuildResponseSchema, {
          signal
        })
      ).build,
    cancelBuild: async (envId, buildId, signal) =>
      (
        await call(
          'POST',
          buildPath(envId, buildId, '/cancel'),
          HostedEnvironmentBuildResponseSchema,
          { signal }
        )
      ).build,
    activateBuild: async (envId, buildId, signal) =>
      (
        await call(
          'POST',
          buildPath(envId, buildId, '/activate'),
          HostedEnvironmentResponseSchema,
          {
            signal
          }
        )
      ).environment,
    staleness: async (envId, refresh, signal) =>
      (
        await call(
          'GET',
          envPath(envId, refresh ? '/staleness?refresh=1' : '/staleness'),
          HostedEnvironmentStalenessResponseSchema,
          { signal }
        )
      ).staleness,
    openBuildEvents: async (envId, buildId, signal) => {
      // Only the response headers are bounded; the body streams for the whole build.
      const headerTimeout = AbortSignal.timeout(timeoutMs)
      const controller = new AbortController()
      const onAbort = (): void => controller.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      headerTimeout.addEventListener('abort', onAbort, { once: true })
      let response: Response
      try {
        response = await send('GET', buildPath(envId, buildId, '/events'), {
          signal: controller.signal,
          accept: 'application/x-ndjson'
        })
      } catch (error) {
        throw transportError(error, signal, headerTimeout)
      } finally {
        headerTimeout.removeEventListener('abort', onAbort)
      }
      if (!response.ok || !response.body) {
        const payload = await readJson(response).catch(() => null)
        throw errorFromResponse(response.status, payload)
      }
      return response.body
    }
  }
}

function envPath(envId: string, suffix = ''): string {
  if (!isHostedEnvironmentId(envId)) {
    throw new HostedEnvironmentRequestError(
      'invalid_request',
      'environment_id',
      'Invalid environment id.'
    )
  }
  return `v1/environments/${envId}${suffix}`
}

function buildPath(envId: string, buildId: string, suffix = ''): string {
  if (!isHostedEnvironmentBuildId(buildId)) {
    throw new HostedEnvironmentRequestError('invalid_request', 'build_id', 'Invalid build id.')
  }
  return envPath(envId, `/builds/${buildId}${suffix}`)
}
