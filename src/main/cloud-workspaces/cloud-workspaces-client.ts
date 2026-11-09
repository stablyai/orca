// HTTPS client for the team workspace registry on the sandbox control plane. Same auth as the
// hosted sandbox driver: a short-lived Orca token (aud=orca-sandbox), never a provider credential.
import type { z } from 'zod'
import { errorMessage } from '../../shared/error-message'
import {
  CloudWorkspaceGrantIssuedSchema,
  CloudWorkspaceGrantListSchema,
  CloudWorkspaceLinkResponseSchema,
  CloudWorkspaceListResponseSchema,
  CloudWorkspacePresenceResponseSchema,
  CloudWorkspaceResponseSchema,
  OrgPromptsSchema,
  type CloudWorkspaceListQuery,
  type CloudWorkspacePatch,
  type OrgPrompts
} from '../../shared/cloud-workspaces/cloud-workspaces-wire'

export class CloudWorkspacesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason?: string
  ) {
    super(reason ? `${code}:${reason}` : code)
    this.name = 'CloudWorkspacesError'
  }
}

export type CloudWorkspacesClientOptions = {
  baseUrl: string
  getAccessToken: (signal?: AbortSignal) => Promise<string>
  fetch?: typeof fetch
}

const CONTROL_TIMEOUT_MS = 20_000
// Opening a sleeping teammate workspace includes a VM boot.
const GRANT_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 512 * 1024

export function createCloudWorkspacesClient(options: CloudWorkspacesClientOptions) {
  const doFetch = options.fetch ?? fetch
  const base = new URL(options.baseUrl)

  async function call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    timeoutMs = CONTROL_TIMEOUT_MS
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs)
    let token: string
    try {
      token = await options.getAccessToken(signal)
    } catch (error) {
      // No usable Orca session (signed out, refresh failed): callers treat this like a 401.
      throw new CloudWorkspacesError(401, 'unauthorized', errorMessage(error).slice(0, 120))
    }
    let response: Response
    try {
      response = await doFetch(new URL(path, base), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect could forward the bearer token to another origin.
        redirect: 'manual',
        signal
      })
    } catch (error) {
      throw new CloudWorkspacesError(
        0,
        signal.aborted ? 'timeout' : 'unavailable',
        errorMessage(error).slice(0, 120)
      )
    }
    const text = await response.text()
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new CloudWorkspacesError(response.status, 'invalid_response')
    }
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      throw new CloudWorkspacesError(response.status, 'invalid_response')
    }
    if (!response.ok) {
      const err: Record<string, unknown> = isRecord(payload) ? payload : {}
      throw new CloudWorkspacesError(
        response.status,
        typeof err.error === 'string' ? err.error : 'error',
        typeof err.reason === 'string' ? err.reason : undefined
      )
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new CloudWorkspacesError(response.status, 'invalid_response')
    }
    return parsed.data
  }

  const ws = (id: string) => `/v1/team/workspaces/${encodeURIComponent(id)}`

  return {
    async list(query: CloudWorkspaceListQuery = {}) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) {
        if (value) {
          params.set(key, value)
        }
      }
      const qs = params.toString()
      return (
        await call(
          'GET',
          `/v1/team/workspaces${qs ? `?${qs}` : ''}`,
          CloudWorkspaceListResponseSchema
        )
      ).workspaces
    },
    async get(id: string) {
      return (await call('GET', ws(id), CloudWorkspaceResponseSchema)).workspace
    },
    async patch(id: string, patch: CloudWorkspacePatch) {
      return call('PATCH', ws(id), CloudWorkspaceResponseSchema.extend({}).passthrough(), patch)
    },
    async presence(
      id: string,
      body: { clientId: string; state: 'viewing' | 'typing' | 'left'; chatId?: string | null }
    ) {
      return (await call('POST', `${ws(id)}/presence`, CloudWorkspacePresenceResponseSchema, body))
        .presence
    },
    async wake(id: string) {
      return (
        await call('POST', `${ws(id)}/wake`, CloudWorkspaceResponseSchema, {}, GRANT_TIMEOUT_MS)
      ).workspace
    },
    async renewLease(id: string, extendMs: number) {
      return (await call('POST', `${ws(id)}/lease`, CloudWorkspaceResponseSchema, { extendMs }))
        .workspace
    },
    async issueGrant(
      id: string,
      body: { recipientPublicKeyB64: string; deviceLabel: string; deviceKind: 'desktop' | 'mobile' }
    ) {
      return call(
        'POST',
        `${ws(id)}/grants`,
        CloudWorkspaceGrantIssuedSchema,
        body,
        GRANT_TIMEOUT_MS
      )
    },
    async listGrants(id: string) {
      return (await call('GET', `${ws(id)}/grants`, CloudWorkspaceGrantListSchema)).grants
    },
    async revokeGrant(id: string, grantId: string) {
      return call(
        'DELETE',
        `${ws(id)}/grants/${encodeURIComponent(grantId)}`,
        CloudWorkspaceGrantListSchema.partial().passthrough()
      )
    },
    async resolveLink(workspaceId: string, chatId?: string | null) {
      const params = new URLSearchParams({ w: workspaceId })
      if (chatId) {
        params.set('c', chatId)
      }
      return call('GET', `/v1/team/links/resolve?${params}`, CloudWorkspaceLinkResponseSchema)
    },
    getOrgPrompts(): Promise<OrgPrompts> {
      return call('GET', '/v1/team/prompts', OrgPromptsSchema)
    },
    putOrgPrompts(document: OrgPrompts['document'], revision: number): Promise<OrgPrompts> {
      return call('PUT', '/v1/team/prompts', OrgPromptsSchema, { document, revision })
    }
  }
}

export type CloudWorkspacesClient = ReturnType<typeof createCloudWorkspacesClient>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
