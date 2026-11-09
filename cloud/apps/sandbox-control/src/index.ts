// Orca sandbox control plane: owns Orca's Vercel credentials and runs one persistent sandbox per
// Orca Cloud workspace for the signed-in account. Desktop routes (Orca JWT, aud=orca-sandbox):
//   POST   /v1/sandboxes {workspaceId, machineSize, region?, repo?}  -> {sandbox, connection}
//   GET    /v1/sandboxes                                          -> {sandboxes}
//   GET    /v1/sandboxes/:id                                      -> {sandbox}
//   POST   /v1/sandboxes/:id/suspend | /resume | /rollover        -> {sandbox[, connection]}
//   POST   /v1/sandboxes/:id/lease {extendMs}                     -> {sandbox}
//   DELETE /v1/sandboxes/:id                                      -> {sandbox}
//   GET /v1/secrets?scope= | PUT, DELETE /v1/secrets/:scope/:NAME     (see src/secrets.ts)
// Vercel network-policy forwardURL target (Vercel sandbox OIDC):  /v1/egress/proxy
import { authenticateDesktop } from './auth'
import { NO_CREDENTIALS, handleEgressProxy, type CredentialBroker, type ProxiedRoute } from './egress-proxy'
import {
  BillingUnavailableError,
  createEntitlementClient,
  withDevAccountBypass,
  type EntitlementClient
} from './entitlements'
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
import { createGitHubAppMinter, type GitHubAppMinter } from './github-app'
import { reconcile } from './reconcile'
import { egressSecretHosts, secretPlaceholder } from './secret-egress'
import { SecretError, handleSecretsRoute, keyringFor, resolveSandboxSecrets } from './secrets'
import type { Keyring } from './secrets-crypto'
import { ProviderError, type SandboxProviderApi } from './sandbox-provider'
import { VmCommandError } from './sandbox-vm-commands'
import { getSandbox, getSandboxByProviderName, listAccountSandboxes, type SandboxRow } from './store'
import { createVercelSandboxApi } from './vercel-sandbox-api'
import { CreateRequestSchema, LeaseRequestSchema, readyView, sandboxView } from './wire'

const MAX_JSON_BYTES = 16 * 1024

export type Deps = {
  provider?: SandboxProviderApi
  entitlements?: EntitlementClient
  credentials?: CredentialBroker
  github?: GitHubAppMinter
  now?: () => number
  egressFetch?: typeof fetch
  egressKeysForIssuer?: Parameters<typeof handleEgressProxy>[1]['keysForIssuer']
}

// Decrypted model keys for the egress proxy, per sandbox session, for a minute: one D1 read and
// a decrypt per session-minute instead of per model request. Isolate memory only.
const SECRET_CACHE_MS = 60_000
const secretCache = new Map<string, { at: number; env: Promise<Record<string, string>> }>()

function sessionSecretEnv(db: D1Database, keyring: Keyring, row: SandboxRow, now: number): Promise<Record<string, string>> {
  const key = `${row.id}:${row.session_id ?? ''}`
  const hit = secretCache.get(key)
  if (hit && now - hit.at < SECRET_CACHE_MS) {
    return hit.env
  }
  for (const [cached, entry] of secretCache) {
    if (now - entry.at >= SECRET_CACHE_MS) {
      secretCache.delete(cached)
    }
  }
  const env = resolveSandboxSecrets(db, keyring, row).then((resolved) => resolved.env)
  secretCache.set(key, { at: now, env })
  env.catch(() => secretCache.delete(key))
  return env
}

function egressRoutes(env: Env, deps: Deps): (row: SandboxRow, host: string) => ProxiedRoute[] {
  const broker = deps.credentials ?? egressCredentials(env)
  return (row, host) => {
    if (host === 'api.github.com') {
      return [{ header: 'authorization', placeholders: githubPlaceholderHeaders(row), credential: () => broker.authorizationFor(row, host) }]
    }
    const entry = egressSecretHosts(row).find((candidate) => candidate.host === host)
    const keyring = keyringFor(env)
    if (!entry || !keyring) {
      return []
    }
    return Object.entries(entry.headers).map(([header, format]) => ({
      header,
      placeholders: [format(secretPlaceholder(row, entry.slug))],
      credential: async () => {
        const value = (await sessionSecretEnv(env.SANDBOX_DB, await keyring, row, (deps.now ?? Date.now)()))[entry.secret]
        return value ? format(value) : null
      }
    }))
  }
}

const minters = new Map<string, GitHubAppMinter>()
function githubMinter(env: Env): GitHubAppMinter | undefined {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return undefined
  }
  let minter = minters.get(env.GITHUB_APP_ID)
  if (!minter) {
    minter = createGitHubAppMinter({ appId: env.GITHUB_APP_ID, privateKeyPkcs8: env.GITHUB_APP_PRIVATE_KEY })
    minters.set(env.GITHUB_APP_ID, minter)
  }
  return minter
}

function egressCredentials(env: Env): CredentialBroker {
  const minter = githubMinter(env)
  if (!minter) {
    return devCredentials(env)
  }
  return {
    authorizationFor: async (row, host) => {
      if (host !== 'api.github.com' || !row.repo_url) {
        return null
      }
      const minted = await minter.tokenForRepo(row.repo_url)
      return minted ? `Bearer ${minted.token}` : null
    }
  }
}

function html(body: string): Response {
  return new Response(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;margin:3em">${body}`, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  })
}

/**
 * One-click GitHub App creation (manifest flow). Permissions are the minimum for sandbox git:
 * contents write (clone, fetch, push), pull_requests write (open/update PRs from the workspace),
 * metadata read (required by GitHub for any repo access). No webhook: tokens are minted on demand.
 */
function githubManifestStart(url: URL): Response {
  const origin = url.origin
  const manifest = {
    name: 'Orca Cloud (dev)',
    url: origin,
    redirect_url: `${origin}/v1/github/manifest-callback`,
    setup_url: `${origin}/v1/github/setup`,
    setup_on_update: false,
    // Installable on personal accounts too; installing grants nothing until a repo is selected.
    public: true,
    hook_attributes: { url: `${origin}/v1/github/webhook-unused`, active: false },
    default_permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' },
    default_events: [],
    request_oauth_on_install: false
  }
  const state = crypto.randomUUID()
  const escaped = JSON.stringify(manifest).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  console.log(JSON.stringify({ event: 'github_manifest_start' }))
  // No auto-submit: some browsers drop scripted cross-site POSTs, and GitHub still needs its own click.
  return html(
    '<h2>Create the Orca Cloud (dev) GitHub App</h2>' +
      '<p>1. Click the button. 2. On GitHub, scroll down and click <b>Create GitHub App for stablyai</b>.</p>' +
      `<form method=post action="https://github.com/organizations/stablyai/settings/apps/new?state=${state}">` +
      `<input type=hidden name=manifest value="${escaped}">` +
      '<button type=submit style="font-size:18px;padding:10px 18px">Continue to GitHub</button></form>'
  )
}

/** GitHub App manifest flow redirect: the operator's exchange script reads the one-time code from logs. */
function githubManifestCallback(env: Env, url: URL): Response {
  if (env.SANDBOX_ENV === 'prod') {
    return fail('not_found', 404)
  }
  const code = url.searchParams.get('code') ?? ''
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(code)) {
    return html('Missing code.')
  }
  console.log(JSON.stringify({ event: 'github_manifest_code', code, state: url.searchParams.get('state') }))
  return html(
    'GitHub App created. The Orca agent is finishing setup.<p>Next: <a href="https://github.com/apps/orca-cloud-dev/installations/new">install it</a> on <b>nwparker</b> → Only select repositories → <b>orca-sandbox-push-test</b>.'
  )
}

function devCredentials(env: Env): CredentialBroker {
  const value = env.EGRESS_DEV_STATIC_AUTHORIZATION
  if (!value || env.SANDBOX_ENV === 'prod') {
    return NO_CREDENTIALS
  }
  return { authorizationFor: async (_row, host) => (host === 'api.github.com' ? value : null) }
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
async function lifecycleDeps(env: Env, deps: Deps): Promise<LifecycleDeps | null> {
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
    entitlements: deps.entitlements ?? withDevAccountBypass(env, createEntitlementClient(env)),
    github: deps.github ?? githubMinter(env),
    secrets: await secretsDeps(env),
    now: deps.now ?? Date.now,
    config: {
      environment: env.SANDBOX_ENV,
      goldenSnapshotId: env.GOLDEN_SNAPSHOT_ID,
      defaultRegion: env.VERCEL_REGION ?? 'iad1',
      egressProxyUrl: env.EGRESS_PROXY_URL,
      sessionDeadlineMs:
        env.SESSION_DEADLINE_MS && env.SANDBOX_ENV !== 'prod' ? Number(env.SESSION_DEADLINE_MS) : undefined
    }
  }
}

async function secretsDeps(env: Env): Promise<LifecycleDeps['secrets']> {
  const keyring = keyringFor(env)
  if (!keyring) {
    return undefined
  }
  try {
    return { keyring: await keyring, egressPlaceholders: env.SECRETS_EGRESS_PLACEHOLDERS === 'on' }
  } catch {
    // A malformed KEK must not block sandbox starts; the secrets routes surface it as 503.
    console.log(JSON.stringify({ event: 'secrets_kek_invalid' }))
    return undefined
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
        routesFor: egressRoutes(env, deps),
        fetch: deps.egressFetch,
        keysForIssuer: deps.egressKeysForIssuer
      })
    }
    if (url.pathname === '/v1/github/manifest-callback') {
      return githubManifestCallback(env, url)
    }
    if (url.pathname === '/v1/github/manifest-start' && env.SANDBOX_ENV !== 'prod') {
      return githubManifestStart(url)
    }
    if (url.pathname === '/v1/github/setup') {
      return html('Orca Cloud (dev) is installed. You can close this tab.')
    }
    if (url.pathname === '/v1/secrets' || url.pathname.startsWith('/v1/secrets/')) {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      const secrets = await secretsDeps(env)
      if (!secrets) {
        return fail('not_configured', 503)
      }
      return await handleSecretsRoute(request, url, env.SANDBOX_DB, secrets.keyring, caller, (deps.now ?? Date.now)(), readJson)
    }
    const match = /^\/v1\/sandboxes(?:\/([A-Za-z0-9_]+)(?:\/(suspend|resume|lease|rollover))?)?$/.exec(url.pathname)
    if (!match) {
      return fail('not_found', 404)
    }
    const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
    if (!caller) {
      return fail('unauthorized', 401)
    }
    const life = await lifecycleDeps(env, deps)
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
  if (error instanceof SecretError) {
    return fail(error.code, error.status, error.reason)
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
    ctx.waitUntil(
      lifecycleDeps(env, {}).then(async (life) => {
        if (life) {
          // Counts only; no ids, tokens or pairing material.
          const summary = await reconcile(life)
          console.log(JSON.stringify({ event: 'reconcile', ...summary }))
        }
      })
    )
  }
} satisfies ExportedHandler<Env>
