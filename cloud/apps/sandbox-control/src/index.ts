// Orca sandbox control plane: owns Orca's Vercel credentials and runs one persistent sandbox per
// Orca Cloud workspace for the signed-in account. Desktop routes (Orca JWT, aud=orca-sandbox):
//   POST   /v1/sandboxes {workspaceId, machineSize, region?, repo?}  -> {sandbox, connection}
//   GET    /v1/sandboxes                                          -> {sandboxes}
//   GET    /v1/sandboxes/:id                                      -> {sandbox}
//   POST   /v1/sandboxes/:id/suspend | /resume | /rollover        -> {sandbox[, connection]}
//   POST   /v1/sandboxes/:id/lease {extendMs}                     -> {sandbox}
//   DELETE /v1/sandboxes/:id                                      -> {sandbox}
// Vercel network-policy forwardURL target (Vercel sandbox OIDC):  /v1/egress/proxy
import { authenticateDesktop } from './auth'
import { NO_CREDENTIALS, handleEgressProxy, type CredentialBroker } from './egress-proxy'
import { BillingUnavailableError, createEntitlementClient, type EntitlementClient } from './entitlements'
import type { Env } from './env'
import {
  LifecycleError,
  createSandbox,
  destroySandbox,
  githubPlaceholderHeaders,
  renewLease,
  resumeSandbox,
  rolloverSandbox,
  suspendSandbox,
  type LifecycleDeps
} from './lifecycle'
import { reconcile } from './reconcile'
import { ProviderError, type SandboxProviderApi } from './sandbox-provider'
import { VmCommandError } from './sandbox-vm-commands'
import { getSandbox, getSandboxByProviderName, listAccountSandboxes } from './store'
import { createVercelSandboxApi } from './vercel-sandbox-api'
import { CreateRequestSchema, LeaseRequestSchema, readyView, sandboxView } from './wire'

const MAX_JSON_BYTES = 16 * 1024

export type Deps = {
  provider?: SandboxProviderApi
  entitlements?: EntitlementClient
  credentials?: CredentialBroker
  now?: () => number
  egressFetch?: typeof fetch
  egressKeysForIssuer?: Parameters<typeof handleEgressProxy>[1]['keysForIssuer']
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function fail(error: string, status: number, reason?: string): Response {
  return json(reason ? { error, reason } : { error }, status)
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > MAX_JSON_BYTES) {
    throw new SyntaxError('too_large')
  }
  return text ? JSON.parse(text) : {}
}

/** Lifecycle routes refuse to run half-configured rather than guess at Orca's provider account. */
function lifecycleDeps(env: Env, deps: Deps): LifecycleDeps | null {
  if (!env.GOLDEN_SNAPSHOT_ID || (!deps.provider && (!env.VERCEL_TOKEN || !env.VERCEL_TEAM_ID || !env.VERCEL_PROJECT_ID))) {
    return null
  }
  return {
    db: env.SANDBOX_DB,
    provider:
      deps.provider ??
      createVercelSandboxApi({
        token: env.VERCEL_TOKEN!,
        teamId: env.VERCEL_TEAM_ID!,
        projectId: env.VERCEL_PROJECT_ID!,
        baseUrl: env.VERCEL_API_BASE
      }),
    entitlements: deps.entitlements ?? createEntitlementClient(env),
    now: deps.now ?? Date.now,
    config: {
      environment: env.SANDBOX_ENV,
      goldenSnapshotId: env.GOLDEN_SNAPSHOT_ID,
      defaultRegion: env.VERCEL_REGION ?? 'iad1',
      egressProxyUrl: env.EGRESS_PROXY_URL
    }
  }
}

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url)
  try {
    if (url.pathname === '/v1/egress/proxy' || url.pathname.startsWith('/v1/egress/proxy/')) {
      if (!env.VERCEL_TEAM_ID || !env.VERCEL_PROJECT_ID) {
        return fail('not_configured', 503)
      }
      return await handleEgressProxy(request, {
        teamId: env.VERCEL_TEAM_ID,
        projectId: env.VERCEL_PROJECT_ID,
        findSandbox: (name) => getSandboxByProviderName(env.SANDBOX_DB, name),
        placeholdersFor: githubPlaceholderHeaders,
        credentials: deps.credentials ?? NO_CREDENTIALS,
        fetch: deps.egressFetch,
        keysForIssuer: deps.egressKeysForIssuer
      })
    }
    const match = /^\/v1\/sandboxes(?:\/([A-Za-z0-9_]+)(?:\/(suspend|resume|lease|rollover))?)?$/.exec(url.pathname)
    if (!match) {
      return fail('not_found', 404)
    }
    const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
    if (!caller) {
      return fail('unauthorized', 401)
    }
    const life = lifecycleDeps(env, deps)
    if (!life) {
      return fail('not_configured', 503)
    }
    const [, id, action] = match
    if (!id) {
      if (request.method === 'GET') {
        const rows = await listAccountSandboxes(env.SANDBOX_DB, caller.accountId)
        return json({ sandboxes: rows.map(sandboxView) })
      }
      if (request.method !== 'POST') {
        return fail('not_found', 404)
      }
      const body = CreateRequestSchema.safeParse(await readJson(request))
      if (!body.success) {
        return fail('invalid_request', 400)
      }
      const ready = await createSandbox(life, caller, body.data)
      return json(readyView(ready.row, ready.connection))
    }
    const row = await getSandbox(env.SANDBOX_DB, id)
    // Another account's sandbox is indistinguishable from a missing one.
    if (!row || row.account_id !== caller.accountId) {
      return fail('not_found', 404)
    }
    const route = `${request.method} ${action ?? ''}`
    switch (route) {
      case 'GET ':
        return json({ sandbox: sandboxView(row) })
      case 'DELETE ':
        return json({ sandbox: sandboxView(await destroySandbox(life, row)) })
      case 'POST suspend':
        return json({ sandbox: sandboxView(await suspendSandbox(life, row)) })
      case 'POST resume': {
        const ready = await resumeSandbox(life, row)
        return json(readyView(ready.row, ready.connection))
      }
      case 'POST rollover': {
        const ready = await rolloverSandbox(life, row)
        return json(readyView(ready.row, ready.connection))
      }
      case 'POST lease': {
        const body = LeaseRequestSchema.safeParse(await readJson(request))
        if (!body.success) {
          return fail('invalid_request', 400)
        }
        return json({ sandbox: sandboxView(await renewLease(life, row, body.data.extendMs)) })
      }
      default:
        return fail('not_found', 404)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof SyntaxError) {
    return fail('invalid_json', 400)
  }
  if (error instanceof LifecycleError) {
    const status = { not_found: 404, conflict: 409, entitlement_denied: 403, provider_unavailable: 502 }[error.code]
    return fail(error.code, status, error.reason)
  }
  if (error instanceof BillingUnavailableError) {
    return fail('billing_unavailable', 503)
  }
  // Provider and VM failures are summarized; their bodies never reach the desktop.
  if (error instanceof ProviderError || error instanceof VmCommandError) {
    return fail('provider_unavailable', 502, error instanceof VmCommandError ? error.code : undefined)
  }
  return fail('internal_error', 500)
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env)
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const life = lifecycleDeps(env, {})
    if (life) {
      ctx.waitUntil(reconcile(life).then(() => undefined))
    }
  }
} satisfies ExportedHandler<Env>
