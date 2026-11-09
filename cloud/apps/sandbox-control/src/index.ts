// Orca sandbox control plane: owns Orca's Vercel credentials and runs one persistent sandbox per
// Orca Cloud workspace for the signed-in account. Desktop routes (Orca JWT, aud=orca-sandbox):
//   POST   /v1/sandboxes {workspaceId, machineSize, region?, repo?}  -> {sandbox, connection}
//   GET    /v1/sandboxes                                          -> {sandboxes}
//   GET    /v1/sandboxes/:id                                      -> {sandbox}
//   POST   /v1/sandboxes/:id/suspend | /resume | /rollover        -> {sandbox[, connection]}
//   POST   /v1/sandboxes/:id/lease {extendMs}                     -> {sandbox}
//   DELETE /v1/sandboxes/:id                                      -> {sandbox}
//   GET /v1/secrets?scope= | PUT, DELETE /v1/secrets/:scope/:NAME     (see src/secrets.ts)
//   POST   /v1/github/connect -> {installUrl, authorizeUrl}  (bind a GitHub App installation to the account)
//   GET    /v1/github/installations                          -> {installations}
// Browser (GitHub redirects): GET /v1/github/setup, GET /v1/github/callback
// Operator (OPERATOR_TOKEN): /v1/internal/* (see operator.ts)
// Vercel network-policy forwardURL target (Vercel sandbox OIDC):  /v1/egress/proxy
import { maintainPool, poolConfigFromEnv } from './pool'
import { authenticateDesktop } from './auth'
import { authenticateApi } from './api/caller'
import { handleApi, handleApiAs, isApiPath, type ApiContext, type ApiExtension } from './api/router'
import { handleMcpRoutes, isMcpPath, oauthApprovalsApi } from './mcp'
import { retryPendingMessages } from './api/messages'
import { revokeWorkspaceTokens } from './api/keys'
import { provisionWorkspaceToken } from './api/settings'
import { docsPage, openApiDocument } from './api/openapi'
import { advanceGoldenImages, currentGoldenSnapshotId } from './golden-images'
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
  type LifecycleDeps,
  type Ready
} from './lifecycle'
import { createGitHubAppMinter, parseGitHubRepo, type GitHubAppMinter } from './github-app'
import {
  GitHubConnectError,
  authorizeUrl,
  createConnectState,
  handleGitHubReturn,
  installUrl,
  isInstallationBound,
  listAccountInstallations,
  type GitHubConnectConfig
} from './github-connect'
import { GuardrailError, consumeCreateToken, guardrailsFromEnv } from './guardrails'
import { handleOperator, isOperator } from './operator'
import { DEFAULT_RETENTION, type RetentionConfig } from './retention'
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
  /** GitHub OAuth/user API fetch (tests). */
  githubFetch?: typeof fetch
  retention?: RetentionConfig
  /** Anonymous github.com reachability (tests stub it). */
  publicRepoCheck?: (repoUrl: string) => Promise<boolean>
  /** ctx.waitUntil from the Worker entry; tests collect the promises. */
  waitUntil?: (work: Promise<unknown>) => void
  /** Route groups mounted on the public API (routines, see src/routines). */
  apiExtensions?: ApiExtension[]
}

/** The public origin: PUBLIC_API_URL when set, else the request's own origin. */
export function publicOrigin(env: Env, url?: URL): string | undefined {
  const configured = env.PUBLIC_API_URL ?? (env.EGRESS_PROXY_URL ? new URL(env.EGRESS_PROXY_URL).origin : undefined)
  return configured?.replace(/\/+$/, '') ?? url?.origin
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

const minters = new Map<string, { minter: GitHubAppMinter; db: { current: D1Database } }>()
function githubMinter(env: Env): GitHubAppMinter | undefined {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return undefined
  }
  let entry = minters.get(env.GITHUB_APP_ID)
  if (!entry) {
    const db = { current: env.SANDBOX_DB }
    entry = {
      db,
      minter: createGitHubAppMinter({
        appId: env.GITHUB_APP_ID,
        privateKeyPkcs8: env.GITHUB_APP_PRIVATE_KEY,
        isBound: (installationId, accountId) => isInstallationBound(db.current, installationId, accountId)
      })
    }
    minters.set(env.GITHUB_APP_ID, entry)
  }
  entry.db.current = env.SANDBOX_DB
  return entry.minter
}

function githubConnect(env: Env, deps: Deps): GitHubConnectConfig | null {
  if (!env.GITHUB_APP_SLUG || !env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET || (env.GITHUB_STATE_SECRET?.length ?? 0) < 32) {
    return null
  }
  return {
    appSlug: env.GITHUB_APP_SLUG,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    stateSecret: env.GITHUB_STATE_SECRET!,
    fetch: deps.githubFetch
  }
}

function retentionFromEnv(env: Env): RetentionConfig {
  const num = (value: string | undefined, fallback: number, unitMs: number) => {
    const parsed = Number(value)
    return value !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed * unitMs : fallback
  }
  return {
    ...DEFAULT_RETENTION,
    dataRetentionMs: num(env.DATA_RETENTION_DAYS, DEFAULT_RETENTION.dataRetentionMs, 86_400_000),
    idleRetentionMs: num(env.IDLE_RETENTION_DAYS, DEFAULT_RETENTION.idleRetentionMs, 86_400_000),
    orphanGraceMs: num(env.ORPHAN_GRACE_HOURS, DEFAULT_RETENTION.orphanGraceMs, 3_600_000)
  }
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
      const minted = await minter.tokenForRepo(row.repo_url, row.account_id)
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
    // members:read lets the bind step confirm an org installer is an org admin (user-to-server token).
    default_permissions: { contents: 'write', metadata: 'read', pull_requests: 'write', members: 'read' },
    default_events: [],
    // The setup URL sends the browser through OAuth itself, so existing installs can be bound too.
    callback_urls: [`${origin}/v1/github/callback`],
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

/** Ready answers carry phase timings as Server-Timing so clients and dashboards can see the slow step. */
function readyResponse(ready: Ready): Response {
  const response = json(readyView(ready.row, ready.connection))
  const timing = Object.entries(ready.timings ?? {})
    .map(([phase, ms]) => `${phase};dur=${ms}`)
    .join(', ')
  if (timing) {
    response.headers.set('server-timing', timing)
  }
  return response
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

async function apiContext(env: Env, deps: Deps, request: Request, life?: Promise<ApiContext['life']>): Promise<ApiContext> {
  return {
    db: env.SANDBOX_DB,
    now: deps.now ?? Date.now,
    life: await (life ?? lifecycleDeps(env, deps)),
    waitUntil: deps.waitUntil ?? ((promise) => void promise.catch(() => undefined)),
    readJson: () => readJson(request),
    extensions: [oauthApprovalsApi, ...(deps.apiExtensions ?? [])]
  }
}

/** Lifecycle routes refuse to run half-configured rather than guess at Orca's provider account. */
async function lifecycleDeps(env: Env, deps: Deps): Promise<LifecycleDeps | null> {
  if (!deps.provider && (!env.VERCEL_TOKEN || !env.VERCEL_TEAM_ID || !env.VERCEL_PROJECT_ID)) {
    return null
  }
  // The Worker rotates golden images itself (golden-images.ts); the var only seeds the first one.
  const goldenSnapshotId = await currentGoldenSnapshotId(env.SANDBOX_DB, env.GOLDEN_SNAPSHOT_ID)
  if (!goldenSnapshotId) {
    return null
  }
  const provider =
    deps.provider ??
    createVercelSandboxApi({
      token: env.VERCEL_TOKEN!,
      teamId: env.VERCEL_TEAM_ID!,
      projectId: env.VERCEL_PROJECT_ID!,
      baseUrl: env.VERCEL_API_BASE
    })
  return {
    db: env.SANDBOX_DB,
    provider,
    entitlements: deps.entitlements ?? withDevAccountBypass(env, createEntitlementClient(env)),
    github: deps.github ?? githubMinter(env),
    secrets: await secretsDeps(env),
    now: deps.now ?? Date.now,
    retention: deps.retention ?? retentionFromEnv(env),
    background: deps.waitUntil,
    publicRepoCheck: deps.publicRepoCheck ?? ((repoUrl) => githubRepoIsPublic(repoUrl)),
    hooks: {
      afterBoot: (row, sessionId) =>
        provisionWorkspaceToken({ db: env.SANDBOX_DB, provider, now: deps.now ?? Date.now, apiUrl: publicOrigin(env) }, row, sessionId),
      afterStop: (row) => revokeWorkspaceTokens(env.SANDBOX_DB, row.id, (deps.now ?? Date.now)())
    },
    config: {
      pool: poolConfigFromEnv(env),
      extraEgressHosts: (env.EGRESS_EXTRA_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean),
      guardrails: guardrailsFromEnv(env),
      snapshotExpirationMs:
        env.SNAPSHOT_EXPIRATION_DAYS && Number(env.SNAPSHOT_EXPIRATION_DAYS) >= 1
          ? Math.floor(Number(env.SNAPSHOT_EXPIRATION_DAYS)) * 86_400_000
          : undefined,
      environment: env.SANDBOX_ENV,
      goldenSnapshotId,
      defaultRegion: env.VERCEL_REGION ?? 'iad1',
      egressProxyUrl: env.EGRESS_PROXY_URL,
      sessionDeadlineMs:
        env.SESSION_DEADLINE_MS && env.SANDBOX_ENV !== 'prod' ? Number(env.SESSION_DEADLINE_MS) : undefined
    }
  }
}

/**
 * Smart-HTTP ref advertisement, anonymous: 200 for a public repo, 401 for private or missing. Not the
 * REST API, so no 60/h anonymous quota. Network trouble counts as public: the clone then reports it.
 */
async function githubRepoIsPublic(repoUrl: string): Promise<boolean> {
  const parsed = parseGitHubRepo(repoUrl)
  if (!parsed) {
    return true
  }
  try {
    const response = await fetch(
      `https://github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}.git/info/refs?service=git-upload-pack`,
      { redirect: 'manual', headers: { 'user-agent': 'orca-sandbox-control' }, signal: AbortSignal.timeout(5_000) }
    )
    await response.body?.cancel()
    return response.status !== 401 && response.status !== 404
  } catch {
    return true
  }
}

/** Keeps a smoke-tested golden image current: refresh before expiry, rebuild on a new release. */
async function advanceGoldenImagesFromEnv(env: Env): Promise<void> {
  if (!env.VERCEL_TOKEN || !env.VERCEL_TEAM_ID || !env.VERCEL_PROJECT_ID) {
    return
  }
  const days = Number(env.GOLDEN_SNAPSHOT_EXPIRATION_DAYS ?? '0')
  const tick = await advanceGoldenImages({
    db: env.SANDBOX_DB,
    provider: createVercelSandboxApi({
      token: env.VERCEL_TOKEN,
      teamId: env.VERCEL_TEAM_ID,
      projectId: env.VERCEL_PROJECT_ID,
      baseUrl: env.VERCEL_API_BASE
    }),
    now: Date.now,
    config: {
      environment: env.SANDBOX_ENV,
      region: env.VERCEL_REGION ?? 'iad1',
      expirationMs: Number.isFinite(days) && days >= 1 ? Math.floor(days) * 86_400_000 : 0,
      source: env.GOLDEN_IMAGE_SOURCE,
      seedSnapshotId: env.GOLDEN_SNAPSHOT_ID,
      refreshBeforeMs: env.GOLDEN_REFRESH_BEFORE_HOURS ? Number(env.GOLDEN_REFRESH_BEFORE_HOURS) * 3_600_000 : undefined
    }
  })
  if (tick !== 'idle') {
    console.log(JSON.stringify({ event: 'golden_image_tick', tick }))
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
    if (url.pathname === '/v1/github/setup' || url.pathname === '/v1/github/callback') {
      return await githubReturn(env, deps, url)
    }
    if (url.pathname.startsWith('/v1/internal/')) {
      if (!(await isOperator(request, env.OPERATOR_TOKEN))) {
        return fail('not_found', 404)
      }
      const life = await lifecycleDeps(env, deps)
      if (!life) {
        return fail('not_configured', 503)
      }
      return (
        (await handleOperator(request, url.pathname, {
          life,
          github: deps.github ?? githubMinter(env),
          readJson: () => readJson(request)
        })) ?? fail('not_found', 404)
      )
    }
    if (url.pathname === '/v1/github/dev-connect' && env.SANDBOX_ENV !== 'prod') {
      // Dev-only, link-shareable start of the user flow: mints a fresh 10-min state per click for a dev:<sub>
      // account (desktop builds call POST /v1/github/connect instead).
      const connect = githubConnect(env, deps)
      const sub = url.searchParams.get('sub') ?? ''
      if (!connect || !/^[A-Za-z0-9_.-]{1,64}$/.test(sub)) {
        return fail('not_found', 404)
      }
      const state = await createConnectState(env.SANDBOX_DB, connect.stateSecret, { accountId: `dev:${sub}`, userId: sub }, (deps.now ?? Date.now)())
      return Response.redirect(authorizeUrl(connect, url.origin, state), 302)
    }
    if (url.pathname === '/v1/github/connect' || url.pathname === '/v1/github/installations') {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      if (url.pathname === '/v1/github/installations' && request.method === 'GET') {
        const rows = await listAccountInstallations(env.SANDBOX_DB, caller.accountId)
        return json({
          installations: rows.map((r) => ({ installationId: r.installation_id, account: r.github_account_login, accountType: r.github_account_type, boundAt: r.created_at }))
        })
      }
      const connect = githubConnect(env, deps)
      if (url.pathname !== '/v1/github/connect' || request.method !== 'POST') {
        return fail('not_found', 404)
      }
      if (!connect) {
        return fail('not_configured', 503)
      }
      const state = await createConnectState(env.SANDBOX_DB, connect.stateSecret, caller, (deps.now ?? Date.now)())
      return json({ installUrl: installUrl(connect, state), authorizeUrl: authorizeUrl(connect, url.origin, state) })
    }
    if (url.pathname === '/v1/openapi.json' && request.method === 'GET') {
      return Response.json(openApiDocument(publicOrigin(env, url)!), { headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } })
    }
    if ((url.pathname === '/docs' || url.pathname === '/docs/') && request.method === 'GET') {
      return docsPage(publicOrigin(env, url)!)
    }
    if (isApiPath(url.pathname)) {
      try {
        return await handleApi(request, url, env, await apiContext(env, deps, request))
      } catch (error) {
        return errorResponse(error)
      }
    }
    if (isMcpPath(url.pathname)) {
      // Hosted MCP server (src/mcp): every tool call runs through the public API as the MCP caller.
      const now = deps.now ?? Date.now
      let life: Promise<ApiContext['life']> | undefined
      return await handleMcpRoutes(request, url, {
        origin: publicOrigin(env, url)!,
        db: env.SANDBOX_DB,
        now,
        allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
        authenticate: (req) => authenticateApi(env, req, now()),
        api: async (caller, method, path, body) => {
          const inner = new Request(new URL(path, url.origin), {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
          })
          life ??= lifecycleDeps(env, deps)
          try {
            return await handleApiAs(caller, inner, new URL(inner.url), await apiContext(env, deps, inner, life))
          } catch (error) {
            return errorResponse(error)
          }
        }
      })
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
        // Routine runs and other machine-made workspaces stay out of the desktop's list.
        const rows = (await listAccountSandboxes(env.SANDBOX_DB, caller.accountId)).filter((row) => (row as { hidden?: number }).hidden !== 1)
        return json({ sandboxes: rows.map(sandboxView) })
      }
      if (request.method !== 'POST') {
        return fail('not_found', 404)
      }
      await consumeCreateToken(life.db, life.config.guardrails!, caller.accountId, life.now())
      const body = CreateRequestSchema.safeParse(await readJson(request))
      if (!body.success) {
        return fail('invalid_request', 400)
      }
      const ready = await createSandbox(life, caller, body.data)
      return readyResponse(ready)
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
        return readyResponse(ready)
      }
      case 'POST rollover': {
        const ready = await rolloverSandbox(life, row)
        return readyResponse(ready)
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

async function githubReturn(env: Env, deps: Deps, url: URL): Promise<Response> {
  const connect = githubConnect(env, deps)
  if (!connect) {
    // Not configured for binding: an install alone grants nothing.
    return html('Orca Cloud is installed on GitHub. Connect it from Orca to use it with your workspaces.')
  }
  try {
    const result = await handleGitHubReturn(env.SANDBOX_DB, connect, url, (deps.now ?? Date.now)())
    if ('redirect' in result) {
      return new Response(null, { status: 302, headers: { location: result.redirect, 'cache-control': 'no-store' } })
    }
    if ('error' in result) {
      return html(
        result.error === 'state_used'
          ? 'This link was already used. Start again from Orca.'
          : 'GitHub is installed, but this page was not opened from Orca. Start from Orca to connect it to your account.'
      )
    }
    const esc = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, '')
    return html(
      result.bound.length > 0
        ? `Connected GitHub ${result.bound.map((login) => `<b>${esc(login)}</b>`).join(', ')} to Orca. You can close this tab.`
        : 'Nothing was connected: only the owner of a personal account or an organization admin can connect an installation.'
    )
  } catch (error) {
    if (error instanceof GitHubConnectError) {
      return html('GitHub did not confirm the sign-in. Start again from Orca.')
    }
    throw error
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof SyntaxError) {
    return fail('invalid_json', 400)
  }
  if (error instanceof SecretError) {
    return fail(error.code, error.status, error.reason)
  }
  if (error instanceof GuardrailError) {
    if (error.code === 'concurrency_limit') {
      return fail('entitlement_denied', 403, 'concurrency_limit')
    }
    const status = { maintenance: 503, capacity: 503, rate_limited: 429 }[error.code]
    const response = fail(error.code, status)
    if (error.retryAfterSeconds) {
      response.headers.set('retry-after', String(error.retryAfterSeconds))
    }
    return response
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
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, { waitUntil: (work) => ctx.waitUntil(work.catch(() => undefined)) })
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      lifecycleDeps(env, {}).then(async (life) => {
        if (life) {
          // Counts only; no ids, tokens or pairing material.
          const summary = await reconcile(life)
          console.log(JSON.stringify({ event: 'reconcile', ...summary }))
          // Runs with the pool off too: that is how a size change to 0 or the kill switch drains it.
          const pool = await maintainPool(life).catch((error: unknown) => ({ error: String(error).slice(0, 200) }))
          console.log(JSON.stringify({ event: 'pool', ...pool }))
          const retried = await retryPendingMessages(life).catch(() => -1)
          if (retried !== 0) {
            console.log(JSON.stringify({ event: 'message_retry', retried }))
          }
        }
        await advanceGoldenImagesFromEnv(env).catch((error: unknown) =>
          console.log(JSON.stringify({ event: 'golden_image_tick_failed', error: String(error).slice(0, 200) }))
        )
      })
    )
  }
} satisfies ExportedHandler<Env>
