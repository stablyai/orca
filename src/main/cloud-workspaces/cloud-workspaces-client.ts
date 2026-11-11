// HTTPS client for the team workspace registry on the sandbox control plane. Same auth as the
// hosted sandbox driver: a short-lived Orca token (aud=orca-sandbox), never a provider credential.
import { z } from 'zod'
import { errorMessage } from '../../shared/error-message'
import { HOSTED_SANDBOX_STATUSES } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { SealedReadSnapshot } from '../../shared/cloud-workspaces/read-snapshot'
import {
  CloudReadSnapshotResponseSchema,
  CloudReaderKeyResponseSchema,
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
import {
  PokeInboxSchema,
  PokeSentSchema,
  PokeSettingsSchema,
  TeammateProfileResponseSchema
} from '../../shared/cloud-workspaces/team-presence-wire'

const NoteSentSchema = z.object({ ok: z.literal(true) })
/** DELETE and POST suspend on /v1/sandboxes/:id answer with the sandbox's new state, not `{ok}`. */
const SandboxStateSchema = z.object({
  sandbox: z.object({ id: z.string(), status: z.enum(HOSTED_SANDBOX_STATUSES) })
})

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
// A read snapshot carries chat tails (bounded by READ_SNAPSHOT_LIMITS), base64 over AES-GCM.
const MAX_READ_SNAPSHOT_BYTES = 16 * 1024 * 1024

/** The read-snapshot 404s are states, not failures: each has its own copy. */
const READ_SNAPSHOT_MISSES = ['not_found', 'no_snapshot', 'not_sealed_for_key'] as const
export type ReadSnapshotMiss = (typeof READ_SNAPSHOT_MISSES)[number]
export type ReadSnapshotFetch =
  | { kind: 'sealed'; sealed: SealedReadSnapshot }
  | { kind: ReadSnapshotMiss }

export function createCloudWorkspacesClient(options: CloudWorkspacesClientOptions) {
  const doFetch = options.fetch ?? fetch
  const base = new URL(options.baseUrl)

  async function call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    timeoutMs = CONTROL_TIMEOUT_MS,
    maxBytes = MAX_RESPONSE_BYTES
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
    if (text.length > maxBytes) {
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
      return call('GET', `/v1/team/workspaces${qs ? `?${qs}` : ''}`, CloudWorkspaceListResponseSchema)
    },
    async get(id: string) {
      return (await call('GET', ws(id), CloudWorkspaceResponseSchema)).workspace
    },
    async patch(id: string, patch: CloudWorkspacePatch) {
      return call('PATCH', ws(id), CloudWorkspaceResponseSchema.extend({}).passthrough(), patch)
    },
    async noteSent(id: string) {
      await call('POST', `${ws(id)}/sent`, NoteSentSchema, {})
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
    /** Owner or team admin: put the sandbox to sleep (counts as a person choosing to sleep it). */
    async sleep(id: string): Promise<void> {
      await call('POST', `/v1/sandboxes/${encodeURIComponent(id)}/suspend`, SandboxStateSchema)
    },
    /** Owner or team admin: delete the sandbox and its disk (grants revoked server-side). */
    async destroy(id: string): Promise<void> {
      const { sandbox } = await call(
        'DELETE',
        `/v1/sandboxes/${encodeURIComponent(id)}`,
        SandboxStateSchema
      )
      // Why: only "destroyed" means the sandbox stopped billing; anything else isn't a delete.
      if (sandbox.status !== 'destroyed') {
        throw new CloudWorkspacesError(200, 'not_destroyed', sandbox.status)
      }
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
    /** Idempotent per (user, account, public key): the same id comes back, lastSeenAt bumped. */
    async registerReaderKey(body: {
      publicKeyB64: string
      deviceLabel: string
      deviceKind: 'desktop' | 'mobile'
    }) {
      return (await call('PUT', '/v1/reader-keys', CloudReaderKeyResponseSchema, body)).readerKey
    },
    /** Server-side revoke: wrapped keys for it are pruned and it is never resurrected. */
    async deleteReaderKey(keyId: string, timeoutMs = CONTROL_TIMEOUT_MS): Promise<void> {
      await call(
        'DELETE',
        `/v1/reader-keys/${encodeURIComponent(keyId)}`,
        NoteSentSchema.passthrough(),
        undefined,
        timeoutMs
      )
    },
    async getReadSnapshot(id: string, keyId: string): Promise<ReadSnapshotFetch> {
      try {
        const { snapshot } = await call(
          'GET',
          `${ws(id)}/read-snapshot?${new URLSearchParams({ keyId })}`,
          CloudReadSnapshotResponseSchema,
          undefined,
          CONTROL_TIMEOUT_MS,
          MAX_READ_SNAPSHOT_BYTES
        )
        return { kind: 'sealed', sealed: snapshot }
      } catch (error) {
        const miss =
          error instanceof CloudWorkspacesError && error.status === 404
            ? READ_SNAPSHOT_MISSES.find((code) => code === error.code)
            : undefined
        if (miss) {
          return { kind: miss }
        }
        throw error
      }
    },
    getOrgPrompts(): Promise<OrgPrompts> {
      return call('GET', '/v1/team/prompts', OrgPromptsSchema)
    },
    putOrgPrompts(document: OrgPrompts['document'], revision: number): Promise<OrgPrompts> {
      return call('PUT', '/v1/team/prompts', OrgPromptsSchema, { document, revision })
    },
    async teammateProfile(userId: string, utcOffsetMin: number) {
      const qs = new URLSearchParams({ utcOffsetMin: String(utcOffsetMin) })
      return (
        await call(
          'GET',
          `/v1/team/members/${encodeURIComponent(userId)}/profile?${qs}`,
          TeammateProfileResponseSchema
        )
      ).profile
    },
    async poke(userId: string) {
      return (
        await call(
          'POST',
          `/v1/team/members/${encodeURIComponent(userId)}/poke`,
          PokeSentSchema,
          {}
        )
      ).poke
    },
    pokeInbox() {
      return call('GET', '/v1/team/pokes', PokeInboxSchema)
    },
    async setPokesEnabled(enabled: boolean) {
      return (await call('PUT', '/v1/team/pokes/settings', PokeSettingsSchema, { enabled })).enabled
    },
    async markPokesSeen(ids: string[]) {
      await call('POST', '/v1/team/pokes/seen', NoteSentSchema, { ids })
    }
  }
}

export type CloudWorkspacesClient = ReturnType<typeof createCloudWorkspacesClient>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
