// HTTP client for the Orca Cloud control plane's public /v1 API, used by the desktop's API keys and
// routines settings. Pure (fetch + token source injected) so it is testable without Electron. The
// bearer token never leaves this module: callers get validated data or a CloudApiError code.
import { z } from 'zod'
import {
  CloudApiApprovalSchema,
  CloudApiAuditPageSchema,
  CloudApiCreatedKeySchema,
  CloudApiGrantListSchema,
  CloudApiInstallationListSchema,
  CloudApiKeyListSchema,
  CloudApiMeSchema,
  CloudApiProjectListSchema,
  CloudApiSettingsSchema,
  RoutineCreatedSchema,
  RoutineEnvelopeSchema,
  RoutineListSchema,
  RoutineRunEnvelopeSchema,
  RoutineRunPageSchema,
  RoutineWebhookSchema,
  type CloudApiErrorCode,
  type CreateCloudApiApprovalInput,
  type CreateCloudApiKeyInput,
  type RoutineInput,
  type RoutinePatch,
  type RoutineRunsQuery
} from '../../shared/cloud-api/cloud-api-types'

const REQUEST_TIMEOUT_MS = 20_000
const MAX_DETAIL_CHARS = 200

export class CloudApiError extends Error {
  constructor(
    readonly code: CloudApiErrorCode,
    /** Server-provided reason (e.g. a validation message), safe to show; never a secret. */
    readonly detail?: string,
    readonly retryAfterSeconds?: number
  ) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'CloudApiError'
  }
}

export type CloudApiClientDeps = {
  controlPlaneUrl: string
  getAccessToken: () => Promise<string>
  fetchImpl?: typeof fetch
  /** Maps a token-source failure (signed out, auth down) to an error code. */
  classifyTokenError?: (error: unknown) => CloudApiErrorCode
}

type RequestOptions = {
  body?: unknown
  query?: Record<string, string | number | undefined>
  /** A 404 on this route means the deployment predates it, not a missing record. */
  notFoundMeansUnavailable?: boolean
}

function readServerError(body: unknown): { error?: string; reason?: string } {
  if (typeof body !== 'object' || body === null) {
    return {}
  }
  const record = body as Record<string, unknown>
  const pick = (value: unknown): string | undefined =>
    typeof value === 'string' ? value.slice(0, MAX_DETAIL_CHARS) : undefined
  return { error: pick(record.error), reason: pick(record.reason) }
}

/** Maps a non-2xx control-plane answer to a stable code the renderer can word. */
export function classifyCloudApiResponse(
  status: number,
  body: unknown,
  options: { notFoundMeansUnavailable?: boolean } = {}
): { code: CloudApiErrorCode; detail?: string } {
  const { error, reason } = readServerError(body)
  if (status === 401) {
    return { code: 'signed-out' }
  }
  if (status === 403) {
    if (reason === 'admin_required' || reason?.startsWith('admin_scope:')) {
      return { code: 'admin-required' }
    }
    return { code: 'forbidden', ...(reason ? { detail: reason } : {}) }
  }
  if (status === 404) {
    return { code: options.notFoundMeansUnavailable ? 'not-available' : 'not-found' }
  }
  if (status === 400 || status === 409 || status === 422) {
    return { code: 'invalid-request', ...(reason ? { detail: reason } : {}) }
  }
  if (status === 429) {
    return { code: 'rate-limited' }
  }
  if (status === 503 && error === 'not_configured') {
    return { code: 'not-available' }
  }
  return { code: 'server', detail: error ?? `HTTP ${status}` }
}

export function createCloudApiClient(deps: CloudApiClientDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = `${deps.controlPlaneUrl.replace(/\/+$/, '')}/`

  async function request<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    schema: S,
    options: RequestOptions = {}
  ): Promise<z.infer<S>> {
    let token: string
    try {
      token = await deps.getAccessToken()
    } catch (error) {
      throw new CloudApiError(deps.classifyTokenError?.(error) ?? 'signed-out')
    }
    const url = new URL(path.replace(/^\//, ''), base)
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value))
      }
    }
    let response: Response
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch {
      throw new CloudApiError('network')
    }
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const { code, detail } = classifyCloudApiResponse(response.status, body, options)
      const retryAfter = Number(response.headers.get('retry-after'))
      throw new CloudApiError(
        code,
        detail,
        code === 'rate-limited' && Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : undefined
      )
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new CloudApiError('invalid-response')
    }
    return parsed.data
  }

  const routinePath = (id: string, sub = ''): string =>
    `v1/routines/${encodeURIComponent(id)}${sub}`

  return {
    me: () => request('GET', 'v1/me', CloudApiMeSchema),
    listApiKeys: () => request('GET', 'v1/api-keys', CloudApiKeyListSchema),
    createApiKey: (input: CreateCloudApiKeyInput) =>
      request('POST', 'v1/api-keys', CloudApiCreatedKeySchema, { body: input }),
    revokeApiKey: async (id: string): Promise<void> => {
      await request('DELETE', `v1/api-keys/${encodeURIComponent(id)}`, z.unknown())
    },
    createApproval: (input: CreateCloudApiApprovalInput = {}) =>
      request('POST', 'v1/oauth-approvals', CloudApiApprovalSchema, {
        body: input,
        notFoundMeansUnavailable: true
      }),
    listGrants: () =>
      request('GET', 'v1/oauth-grants', CloudApiGrantListSchema, {
        notFoundMeansUnavailable: true
      }),
    revokeGrant: async (id: string): Promise<void> => {
      await request('DELETE', `v1/oauth-grants/${encodeURIComponent(id)}`, z.unknown())
    },
    getSettings: () => request('GET', 'v1/settings', CloudApiSettingsSchema),
    putSettings: (settings: { vmCliEnabled: boolean }) =>
      request('PUT', 'v1/settings', CloudApiSettingsSchema, { body: settings }),
    listAudit: (query: { limit?: number; before?: number } = {}) =>
      request('GET', 'v1/audit', CloudApiAuditPageSchema, { query }),
    listProjects: () => request('GET', 'v1/projects', CloudApiProjectListSchema),
    listInstallations: () =>
      request('GET', 'v1/github/installations', CloudApiInstallationListSchema, {
        notFoundMeansUnavailable: true
      }),
    listRoutines: () =>
      request('GET', 'v1/routines', RoutineListSchema, { notFoundMeansUnavailable: true }),
    getRoutine: (id: string) => request('GET', routinePath(id), RoutineEnvelopeSchema),
    createRoutine: (input: RoutineInput) =>
      request('POST', 'v1/routines', RoutineCreatedSchema, { body: input }),
    updateRoutine: (id: string, patch: RoutinePatch) =>
      request('PATCH', routinePath(id), RoutineEnvelopeSchema, { body: patch }),
    deleteRoutine: async (id: string): Promise<void> => {
      await request('DELETE', routinePath(id), z.unknown())
    },
    runRoutine: (id: string) => request('POST', routinePath(id, '/run'), RoutineRunEnvelopeSchema),
    rotateRoutineWebhook: (id: string) =>
      request('POST', routinePath(id, '/rotate-webhook'), RoutineWebhookSchema),
    listRoutineRuns: (id: string, query: RoutineRunsQuery = {}) =>
      request('GET', routinePath(id, '/runs'), RoutineRunPageSchema, { query }),
    getRoutineRun: (id: string, runId: string) =>
      request(
        'GET',
        routinePath(id, `/runs/${encodeURIComponent(runId)}`),
        RoutineRunEnvelopeSchema
      )
  }
}

export type CloudApiClient = ReturnType<typeof createCloudApiClient>
