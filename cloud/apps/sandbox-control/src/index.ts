// Orca sandbox control plane: owns Orca's Vercel credentials and runs one persistent sandbox per
// Orca Cloud workspace for the signed-in account. Desktop routes (Orca JWT, aud=orca-sandbox):
//   POST   /v1/sandboxes {workspaceId, machineSize, region?, repo?}  -> {sandbox, connection}
//   GET    /v1/sandboxes                                          -> {sandboxes}
//   GET    /v1/sandboxes/:id                                      -> {sandbox}
//   POST   /v1/sandboxes/:id/suspend | /resume | /rollover        -> {sandbox[, connection]}
//   POST   /v1/sandboxes/:id/lease {extendMs}                     -> {sandbox}
//   POST   /v1/sandboxes/:id/wake[?wait=30s] -> {state, endpoint, readyAt, sandboxId} (idempotent, single-flight;
//          the public API's POST /v1/workspaces/:id/wake answers the same fields plus `workspace`)
//   POST   /v1/sandboxes/:id/restart                              -> {sandbox, connection}
//   GET    /v1/sandboxes/:id/status                               -> {sandbox, status} (live metrics, cost)
//   POST   /v1/sandboxes/:id/archive {pullRequests?, checkouts?}  -> {sandbox}
//   GET    /v1/sandboxes/:id/archive                              -> {archive}
//   POST   /v1/sandboxes/:id/unarchive                            -> {sandbox, connection}
//   DELETE /v1/sandboxes/:id                                      -> {sandbox}
//   POST, GET /v1/sandboxes/:id/shares | DELETE /v1/sandboxes/:id/shares/:shareId | POST /v1/shares/:token/visit
//   POST | DELETE /v1/sandboxes/:id/ssh-keys {publicKey}          -> {ssh: {port, user, hostKey}}
//   GET /v1/secrets?scope= | PUT, DELETE /v1/secrets/:scope/:NAME     (see src/secrets.ts)
//   POST   /v1/github/connect -> {installUrl, authorizeUrl}  (bind a GitHub App installation to the account)
//   GET    /v1/github/installations                          -> {installations}
//   /v1/environments[/...]  org environments + versioned builds (see src/environment-routes.ts)
//   POST   /v1/device-sessions | GET | DELETE /:id  per-phone access (see device-sessions.ts)
// Phones sign their own EdDSA tokens (device-sessions.ts) and act as their user, except that they
// cannot enroll devices, manage secrets or connect GitHub.
//   /v1/team/workspaces[/:id[/presence|wake|lease|grants[/:grantId]]], /v1/team/links/resolve, /v1/team/prompts
//          team workspace registry, presence, per-device grants (src/workspaces.ts, src/grants.ts)
// /v1/sandboxes/* is the owner's lifecycle API: only the workspace's owner (and, for suspend and
// destroy, an org admin) can reach a row there, because resume hands back an orcad pairing offer.
// Browser (GitHub redirects): GET /v1/github/setup, GET /v1/github/callback
// Operator (OPERATOR_TOKEN): /v1/internal/* (see operator.ts)
// Public share links (src/share-gateway.ts): /s/<token>/*, plus the root-path cookie fallback
// Vercel network-policy forwardURL target (Vercel sandbox OIDC):  /v1/egress/proxy
import { ORCA_CLOUD_IDLE_SLEEP_MINUTES } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { z } from 'zod'
import { maintainPool, poolConfigFromEnv } from './pool'
import { cachedCreateTiming } from './create-timing'
import { authenticateDesktop } from './auth'
import { authenticateApi } from './api/caller'
import { handleApi, handleApiAs, isApiPath, type ApiContext, type ApiExtension } from './api/router'
import { handleMcpRoutes, isMcpPath, oauthApprovalsApi, oauthGrantsApi } from './mcp'
import { purgeOAuth } from './mcp/oauth'
import { retryPendingMessages } from './api/messages'
import { revokeWorkspaceTokens } from './api/keys'
import { provisionWorkspaceToken } from './api/settings'
import { docsPage, openApiDocument } from './api/openapi'
import { handleDeviceSessionsRoute } from './device-sessions'
import { createRoutinesApi } from './routines/api'
import { handleRoutineHook, isRoutineHookPath } from './routines/hooks'
import { tickRoutines } from './routines/runs'
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
import { SecretError, handleSecretsRoute, keyringFor, type SecretChange } from './secrets'
import { refreshAfterSecretChange, refreshSandboxEnv } from './env-refresh'
import { EgressHostsSchema, egressUserHosts, normalizeUserHosts, setEgressUserHosts } from './egress-hosts'
import { cachedProviderEnv } from './session-env'
import { credentialTargets } from './provider-env'
import type { Keyring } from './secrets-crypto'
import { ProviderError, type SandboxProviderApi } from './sandbox-provider'
import { DesktopCommandError, VmCommandError, startDesktop } from './sandbox-vm-commands'
import { forgetShareLink, handleShareGateway } from './share-gateway'
import { handleShareRoute, revokeSandboxShares, sharePathMode, shareSecret, shareSecrets } from './share-links'
import { SshKeyRequestSchema, updateSshKey } from './ssh-access'
import { audit } from './api/audit'
import { getSandbox, getSandboxByProviderName, listAccountSandboxes, type SandboxRow } from './store'
import { createVercelSandboxApi } from './vercel-sandbox-api'
import { advanceAllBuilds, tickBuild, unfinishedBuilds, type BuildDeps } from './environment-builds'
import { environmentErrorResponse, handleEnvironmentRoute, isEnvironmentRoute } from './environment-routes'
import { EnvironmentError } from './environments'
import type { GoldenImageProviderApi } from './golden-image-provider'
import { CreateRequestSchema, LeaseRequestSchema, parseWakeWait, readyView, sandboxView } from './wire'
import { ArchiveRequestSchema } from './sandbox-vm-inspect'
import {
  archiveSandbox,
  readArchive,
  restartSandbox,
  unarchiveSandbox,
  wakeSandbox,
  workspaceStatus,
  type WorkspaceConfig
} from './workspace-lifecycle'
import {
  GrantRequestSchema,
  issueGrant,
  listGrants,
  recordOwnerDeviceAndSync,
  revokeForAccessChange,
  revokeGrantsForDeviceSession,
  revokeGrantsForMember,
  revokeOne
} from './grants'
import { getOrgPrompts, putOrgPrompts } from './org-prompts'
import {
  completeUserConnect,
  createUserConnectState,
  disconnectUser,
  getUserTokenRow,
  memberGitIdentity,
  storeUserToken,
  userAuthorizeUrl
} from './github-user-tokens'
import { MEMBER_GIT_WINDOW_MS, memberGitRoutes, memberSentWithin, recordMemberSend } from './member-git'
import {
  PatchSchema,
  PresenceSchema,
  WORKSPACE_ERROR_STATUS,
  WorkspaceError,
  canOpen,
  isOrgAdmin,
  listWorkspaces,
  patchWorkspace,
  reportPresence,
  requireVisible,
  resolveLink,
  workspaceViews
} from './workspaces'
import { rememberCallerName } from './member-names'
import type { SandboxCaller } from './auth'

const MAX_JSON_BYTES = 16 * 1024
/** Archive bodies carry the desktop's cached repo state (file trees) when the VM is already asleep. */
const MAX_ARCHIVE_JSON_BYTES = 256 * 1024
const CentsPerHourSchema = z
  .object({ standard: z.number().int().nonnegative(), large: z.number().int().nonnegative() })
  .partial()
  .strict()
/** Desktops that understand `archived` say so; older strict clients see it as `suspended`. */
const FEATURES_HEADER = 'x-orca-sandbox-features'
/** A pasted .env file: up to 100 values. */
const MAX_BATCH_JSON_BYTES = 160 * 1024
// Public API bodies: routine prompts are up to 20k characters (POST/PATCH /v1/routines).
const MAX_API_JSON_BYTES = 96 * 1024

export type Deps = {
  provider?: SandboxProviderApi & Partial<GoldenImageProviderApi>
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
  /** Build runner override (tests tick builds by hand). */
  scheduleBuild?: BuildDeps['schedule']
  /** ctx.waitUntil from the Worker entry; tests collect the promises. */
  waitUntil?: (work: Promise<unknown>) => void
  /** Route groups mounted on the public API (routines, see src/routines). */
  apiExtensions?: ApiExtension[]
  /** Long-poll sleep (tests advance a fake clock). */
  sleep?: (ms: number) => Promise<void>
  /** Workspace-grant cleanup for a revoked device session (wired by the workspace registry). */
  onDeviceSessionRevoked?: (deviceSessionId: string) => Promise<void>
  /** Share-gateway fetch to the VM's share proxy (tests). */
  shareFetch?: typeof fetch
}

function workspaceConfig(env: Env, deps: Deps): WorkspaceConfig {
  const days = Number(env.ARCHIVE_TTL_DAYS)
  let centsPerHour: WorkspaceConfig['centsPerHour']
  try {
    const parsed = CentsPerHourSchema.safeParse(env.COST_CENTS_PER_HOUR ? JSON.parse(env.COST_CENTS_PER_HOUR) : undefined)
    centsPerHour = parsed.success ? parsed.data : undefined
  } catch {
    centsPerHour = undefined
  }
  const idle = Number(env.IDLE_SLEEP_MINUTES)
  return {
    idleSleepMinutes: Number.isInteger(idle) && idle >= 1 && idle <= 24 * 60 ? idle : undefined,
    archiveTtlMs: Number.isFinite(days) && days >= 1 ? Math.floor(days) * 86_400_000 : undefined,
    centsPerHour,
    background: deps.waitUntil,
    sleep: deps.sleep
  }
}

/** The public origin: PUBLIC_API_URL when set, else the request's own origin. */
export function publicOrigin(env: Env, url?: URL): string | undefined {
  const configured = env.PUBLIC_API_URL ?? (env.EGRESS_PROXY_URL ? new URL(env.EGRESS_PROXY_URL).origin : undefined)
  return configured?.replace(/\/+$/, '') ?? url?.origin
}

/**
 * Hosts every VM may reach beyond the defaults: EGRESS_EXTRA_HOSTS plus this control plane's public
 * host, which the in-VM `orca cloud` CLI calls with its workspace token (credentials.json apiUrl).
 */
export function extraEgressHostsFor(env: Env): string[] {
  const hosts = (env.EGRESS_EXTRA_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean)
  const origin = publicOrigin(env)
  if (origin) {
    hosts.push(new URL(origin).hostname)
  }
  return [...new Set(hosts)]
}

function egressRoutes(env: Env, deps: Deps): (row: SandboxRow, host: string) => Promise<ProxiedRoute[]> {
  const broker = deps.credentials ?? egressCredentials(env)
  const memberGit = memberGitEnabled(env)
  const members = memberGitRoutes({
    db: env.SANDBOX_DB,
    identity: async (row, userId) => {
      const keyring = keyringFor(env)
      const now = (deps.now ?? Date.now)()
      // Only while the member is actively driving this workspace (their own client reported a send).
      return keyring && memberGit(row.account_id) && (await memberSentWithin(env.SANDBOX_DB, row.id, userId, now, memberGitWindowMs(env)))
        ? memberGitIdentity(env.SANDBOX_DB, await keyring, githubConnect(env, deps), row.account_id, userId, now)
        : null
    }
  })
  return async (row, host) => {
    if (host === 'github.com') {
      return members.routes(row, host)
    }
    if (host === 'api.github.com') {
      return [
        // Members first: a member placeholder must never fall through to the app's token.
        ...(await members.routes(row, host)),
        { header: 'authorization', placeholders: githubPlaceholderHeaders(row), credential: () => broker.authorizationFor(row, host) }
      ]
    }
    const entries = egressSecretHosts(row).filter((candidate) => candidate.host === host)
    const keyring = keyringFor(env)
    if (entries.length === 0 || !keyring) {
      return []
    }
    return entries.flatMap((entry) =>
      Object.entries(entry.headers).map(([header, format]) => ({
        header,
        placeholders: [format(secretPlaceholder(row, entry.secret))],
        credential: async () => {
          const current = await cachedProviderEnv(env.SANDBOX_DB, await keyring, row, (deps.now ?? Date.now)())
          // The key must still be meant for this host now (not only at boot): a later edit may
          // have moved it (e.g. a gateway-derived OPENAI_API_KEY replaced by a real OpenAI key).
          const stillHere = credentialTargets(current.env, current.scopes).some(
            (target) => target.secret === entry.secret && target.host === host
          )
          const value = current.env[entry.secret]
          return stillHere && value ? format(value) : null
        }
      }))
    )
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

/**
 * Operator: point the GitHub App's webhook at this Worker with GITHUB_WEBHOOK_SECRET. GitHub's API
 * can set the URL and secret; activating the hook and choosing events stays in the app settings UI.
 */
async function configureAppWebhook(env: Env, deps: Deps, body: unknown): Promise<Response> {
  const minter = deps.github ?? githubMinter(env)
  const target = (body as { url?: unknown } | null)?.url
  if (!minter?.appRequest || !env.GITHUB_WEBHOOK_SECRET) {
    return fail('not_configured', 503)
  }
  if (typeof target !== 'string' || !/^https:\/\/[^\s]+\/v1\/github\/webhook$/.test(target)) {
    return fail('invalid_request', 400)
  }
  const patched = await minter.appRequest('PATCH', '/app/hook/config', { url: target, content_type: 'json', insecure_ssl: '0', secret: env.GITHUB_WEBHOOK_SECRET })
  const config = (await patched.json().catch(() => null)) as { url?: string; content_type?: string } | null
  const app = (await (await minter.appRequest('GET', '/app')).json().catch(() => null)) as { events?: string[]; permissions?: Record<string, string> } | null
  console.log(JSON.stringify({ event: 'github_app_webhook_configured', status: patched.status }))
  return json({ status: patched.status, url: config?.url ?? null, contentType: config?.content_type ?? null, events: app?.events ?? null, permissions: app?.permissions ?? null })
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

async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const text = await request.text()
  if (text.length > maxBytes) {
    throw new SyntaxError('too_large')
  }
  return text ? JSON.parse(text) : {}
}

async function apiContext(env: Env, deps: Deps, request: Request, life?: Promise<ApiContext['life']>): Promise<ApiContext> {
  const resolved = await (life ?? lifecycleDeps(env, deps))
  const routines = createRoutinesApi({
    publicUrl: publicOrigin(env, new URL(request.url))!,
    deps: () => (resolved ? { life: resolved, githubFetch: deps.githubFetch } : null)
  })
  return {
    db: env.SANDBOX_DB,
    now: deps.now ?? Date.now,
    life: resolved,
    waitUntil: deps.waitUntil ?? ((promise) => void promise.catch(() => undefined)),
    readJson: () => readJson(request, MAX_API_JSON_BYTES),
    extensions: [oauthApprovalsApi, oauthGrantsApi, routines, ...(deps.apiExtensions ?? [])]
  }
}

/** Lifecycle routes refuse to run half-configured rather than guess at Orca's provider account. */
async function lifecycleDeps(env: Env, deps: Deps): Promise<LifecycleDeps | null> {
  if (!deps.provider && (!env.VERCEL_TOKEN || !env.VERCEL_TEAM_ID || !env.VERCEL_PROJECT_ID)) {
    return null
  }
  // The Worker rotates golden images itself (golden-images.ts); the var only seeds the first one.
  // Preview versions in dev may pin an image under test (shared D1's active image is the live one).
  const override = env.SANDBOX_ENV !== 'prod' ? env.GOLDEN_SNAPSHOT_OVERRIDE : undefined
  const goldenSnapshotId = override || (await currentGoldenSnapshotId(env.SANDBOX_DB, env.GOLDEN_SNAPSHOT_ID))
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
    memberIdentity: await memberIdentityFor(env, deps),
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
      shareLinkSecret: shareSecret(env),
      extraEgressHosts: extraEgressHostsFor(env),
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

/** Arms the build's runner (one Durable Object per build); a no-op where the binding is absent. */
function buildScheduler(env: Env): BuildDeps['schedule'] {
  const runners = env.ENV_BUILD_RUNNER
  if (!runners) {
    return undefined
  }
  return async (build) => {
    const stub = runners.get(runners.idFromName(build.id))
    const response = await stub.fetch('https://runner/start', { method: 'POST', body: JSON.stringify(build) })
    await response.body?.cancel()
  }
}

function buildDeps(life: LifecycleDeps, deps: Deps, env?: Env): BuildDeps {
  return {
    schedule: deps.scheduleBuild ?? (env ? buildScheduler(env) : undefined),
    db: life.db,
    // SAFETY: the Vercel client implements both; test fakes for builds do too.
    provider: life.provider as BuildDeps['provider'],
    github: life.github,
    keyring: life.secrets?.keyring,
    entitlements: life.entitlements,
    now: life.now,
    waitUntil: deps.waitUntil,
    githubFetch: deps.githubFetch,
    config: {
      environment: life.config.environment,
      goldenSnapshotId: life.config.goldenSnapshotId,
      region: life.config.defaultRegion,
      guardrails: life.config.guardrails
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
      github: githubMinter(env)?.sourceRequest,
      seedSnapshotId: env.GOLDEN_SNAPSHOT_ID,
      refreshBeforeMs: env.GOLDEN_REFRESH_BEFORE_HOURS ? Number(env.GOLDEN_REFRESH_BEFORE_HOURS) * 3_600_000 : undefined
    }
  })
  if (tick !== 'idle') {
    console.log(JSON.stringify({ event: 'golden_image_tick', tick }))
  }
}

/** `on` = every account; `accounts:<id>,<id>` = staged rollout to those accounts; else off. */
export function egressPlaceholderMode(value: string | undefined): boolean | ReadonlySet<string> {
  if (value === 'on') {
    return true
  }
  if (value?.startsWith('accounts:')) {
    return new Set(value.slice('accounts:'.length).split(',').map((id) => id.trim()).filter(Boolean))
  }
  return false
}

/**
 * Git as the sender (MEMBER_GIT_IDENTITY: unset = on for every account, `off`, `on`, or
 * `accounts:<id>,<id>`). orcad attests which paired device sent each turn and the root-only
 * orca-git-identity hands an agent only that member's identity. Residual risk: members share the VM
 * user, so a member with a shell could subvert orcad itself; agents and prompts cannot.
 */
function memberGitWindowMs(env: Env): number {
  const minutes = Number(env.MEMBER_GIT_WINDOW_MINUTES)
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : MEMBER_GIT_WINDOW_MS
}

export function memberGitEnabled(env: Env): (accountId: string) => boolean {
  // On by default: orcad attests each turn's sender and orca-git-identity refuses any other member.
  if (env.MEMBER_GIT_IDENTITY === undefined || env.MEMBER_GIT_IDENTITY.trim() === '') {
    return () => true
  }
  const mode = egressPlaceholderMode(env.MEMBER_GIT_IDENTITY)
  return (accountId) => mode === true || (mode instanceof Set && mode.has(accountId))
}

async function memberIdentityFor(env: Env, deps: Deps): Promise<LifecycleDeps['memberIdentity']> {
  const keyring = keyringFor(env)
  if (!keyring || env.MEMBER_GIT_IDENTITY === 'off') {
    return undefined
  }
  const enabled = memberGitEnabled(env)
  try {
    const ring = await keyring
    return async (row, userId) =>
      enabled(row.account_id)
        ? memberGitIdentity(env.SANDBOX_DB, ring, githubConnect(env, deps), row.account_id, userId, (deps.now ?? Date.now)())
        : null
  } catch {
    return undefined
  }
}

/**
 * Model keys stay out of the VM by default (egress swap): unset or `on` = every account, `off` = no
 * account, `accounts:<id>,<id>` = only those. SECRETS_EGRESS_PLACEHOLDERS_OFF (comma account ids) is
 * the per-team kill switch back to plain env injection.
 */
export function secretsEgressMode(env: Pick<Env, 'SECRETS_EGRESS_PLACEHOLDERS' | 'SECRETS_EGRESS_PLACEHOLDERS_OFF'>) {
  const value = env.SECRETS_EGRESS_PLACEHOLDERS?.trim()
  const egressPlaceholders = value === undefined || value === '' ? true : value === 'off' ? false : egressPlaceholderMode(value)
  const off = new Set((env.SECRETS_EGRESS_PLACEHOLDERS_OFF ?? '').split(',').map((id) => id.trim()).filter(Boolean))
  return { egressPlaceholders, egressPlaceholdersOff: off }
}

async function secretsDeps(env: Env): Promise<LifecycleDeps['secrets']> {
  const keyring = keyringFor(env)
  if (!keyring) {
    return undefined
  }
  try {
    return { keyring: await keyring, ...secretsEgressMode(env) }
  } catch {
    // A malformed KEK must not block sandbox starts; the secrets routes surface it as 503.
    console.log(JSON.stringify({ event: 'secrets_kek_invalid' }))
    return undefined
  }
}

/** Public share-link traffic; null when the request is not for a link. */
async function shareGateway(request: Request, url: URL, env: Env, deps: Deps): Promise<Response | null> {
  const secrets = shareSecrets(env)
  const onShareHost = env.SHARE_HOST_SUFFIX && url.hostname.endsWith(env.SHARE_HOST_SUFFIX)
  if (!secrets || !(onShareHost || (sharePathMode(env) && url.pathname.startsWith('/s/')))) {
    return null
  }
  const provider =
    deps.provider ??
    (env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID
      ? createVercelSandboxApi({ token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID, baseUrl: env.VERCEL_API_BASE })
      : null)
  if (!provider) {
    return null
  }
  return handleShareGateway(request, url, {
    db: env.SANDBOX_DB,
    secrets,
    provider,
    now: deps.now ?? Date.now,
    hostSuffix: env.SHARE_HOST_SUFFIX,
    pathMode: sharePathMode(env),
    fetch: deps.shareFetch,
    // Visitor wake (link opt-in) is the same single-flight wake as every other wake source, billed
    // and entitlement-checked as the owner's. The page polls status, so no long-poll here.
    wake: async (sandbox) => {
      const life = await lifecycleDeps(env, deps)
      if (!life) {
        throw new Error('not_configured')
      }
      const answer = await wakeSandbox(life, sandbox, { waitMs: 0, ...workspaceConfig(env, deps) })
      if (answer.state === 'failed' || answer.state === 'not_found') {
        throw new Error(`wake_${answer.state}`)
      }
    }
  })
}

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url)
  try {
    const shared = await shareGateway(request, url, env, deps)
    if (shared) {
      return shared
    }
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
    if (isRoutineHookPath(url.pathname)) {
      return await handleRoutineHook(request, url, { db: env.SANDBOX_DB, now: deps.now ?? Date.now, githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET })
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
      if (url.pathname === '/v1/internal/routines/tick' && request.method === 'POST') {
        // Preview versions get no cron: drive the routine scheduler from here.
        return json({ tick: await tickRoutines({ life, githubFetch: deps.githubFetch }) })
      }
      if (url.pathname === '/v1/internal/github/app-webhook' && request.method === 'POST') {
        return await configureAppWebhook(env, deps, await readJson(request))
      }
      if (url.pathname === '/v1/internal/dev/member-github' && request.method === 'POST' && env.SANDBOX_ENV !== 'prod') {
        // Dev rehearsal only: stand in a member's GitHub user token with a fresh app installation
        // token for one repo, so git-as-sender can be exercised without a second GitHub human.
        const body = DevMemberGitHubSchema.safeParse(await readJson(request))
        const keyring = keyringFor(env)
        const minter = deps.github ?? githubMinter(env)
        if (!body.success || !keyring || !minter) {
          return fail(body.success ? 'not_configured' : 'invalid_request', body.success ? 503 : 400)
        }
        const minted = await minter.tokenForRepo(body.data.repoUrl, body.data.accountId)
        if (!minted) {
          return fail('not_found', 404)
        }
        await storeUserToken(
          env.SANDBOX_DB,
          await keyring,
          { account_id: body.data.accountId, user_id: body.data.userId },
          { id: body.data.githubUserId, login: body.data.login, name: body.data.name },
          { access: minted.token, refresh: null, accessExpiresAt: minted.expiresAt, refreshExpiresAt: null },
          life.now()
        )
        return json({ stored: true, expiresAt: minted.expiresAt })
      }
      if (url.pathname === '/v1/internal/org-members/removed' && request.method === 'POST') {
        // Auth pushes this when a member leaves or is removed: every device they paired is revoked.
        const body = MemberRemovedSchema.safeParse(await readJson(request))
        if (!body.success) {
          return fail('invalid_request', 400)
        }
        return json(await revokeGrantsForMember(life, body.data.accountId, body.data.userId))
      }
      return (
        (await handleOperator(request, url.pathname, {
          life,
          github: deps.github ?? githubMinter(env),
          readJson: () => readJson(request)
        })) ?? fail('not_found', 404)
      )
    }
    if (url.pathname === '/v1/config' && request.method === 'GET') {
      // Public product constants (no auth): every client reads these instead of hardcoding them.
      const createTiming = await cachedCreateTiming(env.SANDBOX_DB, (deps.now ?? Date.now)())
      return Response.json(
        { idleSleepMinutes: workspaceConfig(env, deps).idleSleepMinutes ?? ORCA_CLOUD_IDLE_SLEEP_MINUTES, ...(createTiming ? { createTiming } : {}) },
        { headers: { 'cache-control': 'public, max-age=300' } }
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
    if (url.pathname === '/v1/device-sessions' || url.pathname.startsWith('/v1/device-sessions/')) {
      const now = (deps.now ?? Date.now)()
      const caller = await authenticateDesktop(env, request, now)
      if (!caller) {
        return fail('unauthorized', 401)
      }
      return await handleDeviceSessionsRoute(request, url, {
        db: env.SANDBOX_DB,
        caller,
        now,
        readJson: () => readJson(request),
        // A revoked phone loses every workspace grant it was issued (its orcad devices too).
        onRevoked:
          deps.onDeviceSessionRevoked ??
          (async (deviceSessionId) => {
            const life = await lifecycleDeps(env, deps)
            if (life) {
              await revokeGrantsForDeviceSession(life, deviceSessionId)
            }
          })
      })
    }
    if (url.pathname === '/v1/github/dev-user-connect' && env.SANDBOX_ENV !== 'prod') {
      // Dev-only, link-shareable start of a member's own GitHub identity (git as the sender) for
      // dev:org:<org> member <sub>; desktop builds call POST /v1/github/user/connect instead.
      const connect = githubConnect(env, deps)
      const sub = url.searchParams.get('sub') ?? ''
      const org = url.searchParams.get('org') ?? ''
      if (!connect || !keyringFor(env) || !/^[A-Za-z0-9_.-]{1,64}$/.test(sub) || !/^[A-Za-z0-9_.-]{1,64}$/.test(org)) {
        return fail('not_found', 404)
      }
      const state = await createUserConnectState(
        env.SANDBOX_DB,
        connect.stateSecret,
        { userId: sub, accountId: `dev:org:${org}`, orgId: org },
        (deps.now ?? Date.now)()
      )
      return Response.redirect(userAuthorizeUrl(connect, url.origin, state), 302)
    }
    if (url.pathname === '/v1/github/user' || url.pathname === '/v1/github/user/connect') {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      if (url.pathname === '/v1/github/user/connect' && request.method === 'POST') {
        const connect = githubConnect(env, deps)
        if (!connect || !keyringFor(env)) {
          return fail('not_configured', 503)
        }
        const state = await createUserConnectState(env.SANDBOX_DB, connect.stateSecret, caller, (deps.now ?? Date.now)())
        return json({ authorizeUrl: userAuthorizeUrl(connect, url.origin, state) })
      }
      if (url.pathname === '/v1/github/user' && request.method === 'GET') {
        const row = await getUserTokenRow(env.SANDBOX_DB, caller.accountId, caller.userId)
        return json(row ? { connected: true, login: row.github_login, githubUserId: row.github_user_id } : { connected: false })
      }
      if (url.pathname === '/v1/github/user' && request.method === 'DELETE') {
        await disconnectUser(env.SANDBOX_DB, caller)
        return json({ connected: false })
      }
      return fail('not_found', 404)
    }
    if (url.pathname === '/v1/github/connect' || url.pathname === '/v1/github/installations') {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      if (caller.deviceSessionId) {
        return fail('forbidden', 403, 'device_session')
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
      if (caller.deviceSessionId) {
        return fail('forbidden', 403, 'device_session')
      }
      const secrets = await secretsDeps(env)
      if (!secrets) {
        return fail('not_configured', 503)
      }
      const changes: SecretChange[] = []
      const response = await handleSecretsRoute(
        request,
        url,
        env.SANDBOX_DB,
        secrets.keyring,
        caller,
        (deps.now ?? Date.now)(),
        (body) => readJson(body, url.pathname.endsWith('/batch') ? MAX_BATCH_JSON_BYTES : MAX_JSON_BYTES),
        (change) => changes.push(change)
      )
      if (changes.length > 0) {
        // Running sessions of this owner get the edit in new shells within seconds; no restart.
        const work = lifecycleDeps(env, deps).then((life) => (life ? refreshAfterSecretChange(life, changes) : 0))
        if (deps.waitUntil) {
          deps.waitUntil(work.catch(() => undefined))
        } else {
          await work
        }
      }
      return response
    }
    if (isEnvironmentRoute(url.pathname)) {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      const life = await lifecycleDeps(env, deps)
      if (!life) {
        return fail('not_configured', 503)
      }
      return await handleEnvironmentRoute(request, url, caller, buildDeps(life, deps, env), () => readJson(request))
    }
    if (/^\/v1\/sandboxes\/[A-Za-z0-9_]+\/shares(?:\/|$)|^\/v1\/shares\//.test(url.pathname)) {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      const secrets = shareSecrets(env)
      // No link URL can be served without either a share domain or (dev) path mode.
      if (!secrets || (!env.SHARE_HOST_SUFFIX && !sharePathMode(env))) {
        return fail('not_configured', 503)
      }
      const answer = await handleShareRoute(request.method, url.pathname, {
        db: env.SANDBOX_DB,
        secret: secrets[0]!,
        secrets,
        caller,
        now: (deps.now ?? Date.now)(),
        origin: url.origin,
        hostSuffix: env.SHARE_HOST_SUFFIX,
        readJson: () => readJson(request),
        forget: forgetShareLink
      })
      return answer ? json(answer.body, answer.status) : fail('not_found', 404)
    }
    if (
      url.pathname === '/v1/team/workspaces' ||
      url.pathname.startsWith('/v1/team/workspaces/') ||
      url.pathname === '/v1/team/links/resolve' ||
      url.pathname === '/v1/team/prompts'
    ) {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      return await workspaceRoute(request, url, env, deps, caller)
    }
    const match =
      /^\/v1\/sandboxes(?:\/([A-Za-z0-9_]+)(?:\/(suspend|resume|lease|rollover|wake|restart|status|archive|unarchive|env\/refresh|egress\/hosts|ssh-keys|desktop))?)?$/.exec(
        url.pathname
      )
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
    const features = (request.headers.get(FEATURES_HEADER) ?? '').split(',').map((f) => f.trim())
    const archivedAware = features.includes('archive')
    // Older desktops parse status strictly: the new field only goes to clients that ask for it.
    const idleMinutesAware = features.includes('idle-minutes')
    const view = (row: SandboxRow) => sandboxView(row, archivedAware)
    if (!id) {
      if (request.method === 'GET') {
        // Routine runs and other machine-made workspaces stay out of the desktop's list.
        const rows = (await listAccountSandboxes(env.SANDBOX_DB, caller.accountId)).filter(
          (row) => (row as { hidden?: number }).hidden !== 1 && !row.workspace_id.startsWith('routine-') && row.user_id === caller.userId
        )
        return json({ sandboxes: rows.map(view) })
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
      await recordOwnerDeviceAndSync(life, ready.row, ready.connection.pairingCode)
      return readyResponse(ready)
    }
    const row = await getSandbox(env.SANDBOX_DB, id)
    const route = `${request.method} ${action ?? ''}`
    const owner = row !== null && row.account_id === caller.accountId && row.user_id === caller.userId
    const adminAction =
      (route === 'DELETE ' || route === 'POST suspend') && row?.account_id === caller.accountId && isOrgAdmin(caller)
    // Another account's (or a teammate's) sandbox is indistinguishable from a missing one.
    if (!row || !(owner || adminAction)) {
      return fail('not_found', 404)
    }
    switch (route) {
      case 'GET ':
        return json({ sandbox: view(row) })
      case 'DELETE ': {
        const destroyed = await destroySandbox(life, row)
        await revokeSandboxShares(env.SANDBOX_DB, row.id, life.now())
        // The VM and its device registry are gone; so is every grant into it.
        await life.db.batch([
          life.db
            .prepare(
              `UPDATE workspace_grants SET status = 'revoked', revoked_at = ?, revoke_reason = 'destroyed' WHERE sandbox_id = ? AND status <> 'revoked'`
            )
            .bind(life.now(), row.id),
          life.db.prepare('DELETE FROM workspace_presence WHERE sandbox_id = ?').bind(row.id)
        ])
        return json({ sandbox: view(destroyed) })
      }
      case 'POST suspend':
        return json({ sandbox: view(await suspendSandbox(life, row)) })
      case 'POST resume': {
        const ready = await resumeSandbox(life, row)
        await recordOwnerDeviceAndSync(life, ready.row, ready.connection.pairingCode)
        return readyResponse(ready)
      }
      case 'POST rollover': {
        const ready = await rolloverSandbox(life, row)
        await recordOwnerDeviceAndSync(life, ready.row, ready.connection.pairingCode)
        return readyResponse(ready)
      }
      case 'POST wake':
        return json(await wakeSandbox(life, row, { waitMs: parseWakeWait(url, await readJson(request)), ...workspaceConfig(env, deps) }))
      case 'POST restart': {
        // User-triggered and unbounded otherwise: shares the per-account start rate limit.
        await consumeCreateToken(life.db, life.config.guardrails!, caller.accountId, life.now())
        const ready = await restartSandbox(life, row)
        await recordOwnerDeviceAndSync(life, ready.row, ready.connection.pairingCode)
        return json(readyView(ready.row, ready.connection))
      }
      case 'GET status':
      {
        const { idleSleepMinutes, ...status } = await workspaceStatus(life, row, workspaceConfig(env, deps))
        return json({ sandbox: view(row), status: idleMinutesAware ? { ...status, idleSleepMinutes } : status })
      }
      case 'POST archive': {
        const body = ArchiveRequestSchema.safeParse(await readJson(request, MAX_ARCHIVE_JSON_BYTES))
        if (!body.success) {
          return fail('invalid_request', 400)
        }
        return json({ sandbox: view(await archiveSandbox(life, row, body.data, workspaceConfig(env, deps))) })
      }
      case 'GET archive':
        return json({ archive: await readArchive(env.SANDBOX_DB, row.id) })
      case 'POST unarchive': {
        const ready = await unarchiveSandbox(life, row)
        return json(readyView(ready.row, ready.connection))
      }
      case 'POST env/refresh':
        return json({ applied: await refreshSandboxEnv(life, row) })
      case 'GET egress/hosts':
        return json({ hosts: egressUserHosts(row) })
      case 'PUT egress/hosts': {
        const body = EgressHostsSchema.safeParse(await readJson(request))
        const hosts = body.success ? normalizeUserHosts(body.data.hosts) : null
        if (!hosts) {
          return fail('invalid_request', 400, 'invalid_host')
        }
        const next = await setEgressUserHosts(life, row, hosts)
        if (!next) {
          return fail('conflict', 409, 'concurrent_transition')
        }
        return json({ hosts: egressUserHosts(next) })
      }
      case 'POST desktop': {
        // Runs only the image's fixed entry point; the desktop listens on the VM's loopback and is
        // reached through the paired runtime's port forward, never a public route. Every call mints
        // a fresh single-use ticket (each WebSocket, including a reconnect, needs its own); it is
        // never logged here.
        if (row.status !== 'running' || !row.session_id) {
          return fail('conflict', 409, `sandbox_${row.status}`)
        }
        const started = Date.now()
        const desktop = await startDesktop(life.provider, row.session_id)
        console.log(JSON.stringify({ event: 'desktop_start', ms: Date.now() - started }))
        return json({
          desktop: { port: desktop.port, path: desktop.path, ticket: desktop.ticket, expiresInMs: desktop.expiresInMs }
        })
      }
      case 'POST lease': {
        const body = LeaseRequestSchema.safeParse(await readJson(request))
        if (!body.success) {
          return fail('invalid_request', 400)
        }
        return json({ sandbox: view(await renewLease(life, row, body.data.extendMs)) })
      }
      case 'POST ssh-keys':
      case 'DELETE ssh-keys': {
        const body = SshKeyRequestSchema.safeParse(await readJson(request))
        if (!body.success) {
          return fail('invalid_request', 400)
        }
        const action = request.method === 'POST' ? 'add' : 'remove'
        const ssh = await updateSshKey(life, row, action, body.data.publicKey)
        // Who granted or revoked shell access to which VM; the key comment names device + workspace.
        await audit(
          env.SANDBOX_DB,
          { accountId: caller.accountId, type: 'user', id: caller.userId, userId: caller.userId },
          {
            action: action === 'add' ? 'sandbox.ssh_key_added' : 'sandbox.ssh_key_removed',
            targetType: 'sandbox',
            targetId: row.id,
            detail: { key: body.data.publicKey.split(' ')[2] }
          },
          life.now()
        ).catch(() => undefined)
        return json({ ssh })
      }
      default:
        return fail('not_found', 404)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

const DevMemberGitHubSchema = z
  .object({
    accountId: z.string().min(1).max(160),
    userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
    repoUrl: z.url({ protocol: /^https$/ }).max(2048),
    login: z.string().min(1).max(64),
    githubUserId: z.number().int().positive(),
    name: z.string().min(1).max(120)
  })
  .strict()

const MemberRemovedSchema = z
  .object({
    accountId: z.string().min(1).max(160).regex(/^(org|dev:org):[A-Za-z0-9_.:-]+$/),
    userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)
  })
  .strict()

async function workspaceRoute(request: Request, url: URL, env: Env, deps: Deps, caller: SandboxCaller): Promise<Response> {
  const db = env.SANDBOX_DB
  const clock = deps.now ?? Date.now
  const now = clock()
  // Labels for teammates' lists; a failure here must never fail the request itself.
  await rememberCallerName(db, caller, now).catch((error: unknown) => console.warn('member_name_write_failed', String(error)))
  if (url.pathname === '/v1/team/links/resolve' && request.method === 'GET') {
    return json(await resolveLink(db, caller, url, now))
  }
  if (url.pathname === '/v1/team/prompts') {
    if (request.method === 'GET') {
      return json(await getOrgPrompts(db, caller))
    }
    if (request.method === 'PUT') {
      return json(await putOrgPrompts(db, caller, await readJson(request), now))
    }
    return fail('not_found', 404)
  }
  if (url.pathname === '/v1/team/workspaces') {
    return request.method === 'GET' ? json(await listWorkspaces(db, caller, url, now)) : fail('not_found', 404)
  }
  const match = /^\/v1\/team\/workspaces\/(sbx_[0-9a-f]{24})(?:\/(presence|wake|lease|grants|sent)(?:\/(grt_[0-9a-f]{24}))?)?$/.exec(url.pathname)
  if (!match) {
    return fail('not_found', 404)
  }
  const [, id, action, grantId] = match
  const row = await requireVisible(db, caller, id!)
  const route = `${request.method} ${action ?? ''}${grantId ? ' :grant' : ''}`
  const view = async (r = row) => (await workspaceViews(db, caller, [r], clock()))[0]
  if (route === 'GET ') {
    return json({ workspace: await view() })
  }
  if (route === 'POST sent') {
    // The caller's own client: "I just sent a message here" (opens their git-as-sender window).
    if (!canOpen(caller, row)) {
      throw new WorkspaceError('not_found')
    }
    await recordMemberSend(db, row.id, caller.userId, now)
    return json({ ok: true })
  }
  if (route === 'POST presence') {
    const body = PresenceSchema.safeParse(await readJson(request))
    if (!body.success) {
      return fail('invalid_request', 400)
    }
    return json(await reportPresence(db, caller, row, body.data, now))
  }
  const life = await lifecycleDeps(env, deps)
  if (!life) {
    return fail('not_configured', 503)
  }
  switch (route) {
    case 'PATCH ': {
      const body = PatchSchema.safeParse(await readJson(request))
      if (!body.success) {
        return fail('invalid_request', 400)
      }
      const patched = await patchWorkspace(db, caller, row, body.data, now)
      const revoked =
        patched.revoke === 'none' ? null : await revokeForAccessChange(life, patched.row, patched.revoke, caller.userId)
      return json({ workspace: await view(patched.row), ...(revoked ? { revoked } : {}) })
    }
    case 'POST wake': {
      if (!canOpen(caller, row)) {
        throw new WorkspaceError('not_found')
      }
      // Never returns the owner's pairing offer; teammates get in through their own grant.
      const ready = await resumeSandbox(life, row)
      return json({ workspace: await view(ready.row) })
    }
    case 'POST lease': {
      if (!canOpen(caller, row)) {
        throw new WorkspaceError('not_found')
      }
      const body = LeaseRequestSchema.safeParse(await readJson(request))
      if (!body.success) {
        return fail('invalid_request', 400)
      }
      return json({ workspace: await view(await renewLease(life, row, body.data.extendMs)) })
    }
    case 'GET grants':
      return json(await listGrants(db, caller, row))
    case 'POST grants': {
      const body = GrantRequestSchema.safeParse(await readJson(request))
      if (!body.success) {
        return fail('invalid_request', 400)
      }
      return json(await issueGrant(life, caller, row, body.data))
    }
    case 'DELETE grants :grant':
      return json(await revokeOne(life, caller, row, grantId!))
    default:
      return fail('not_found', 404)
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
    if ('userConnect' in result) {
      const keyring = keyringFor(env)
      if (!keyring) {
        return html('GitHub sign-in is not available right now. Try again from Orca.')
      }
      const user = await completeUserConnect(env.SANDBOX_DB, await keyring, connect, result.userConnect, result.code, (deps.now ?? Date.now)())
      const esc = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, '')
      return html(`Connected GitHub <b>${esc(user.login)}</b>. Pushes from shared Orca Cloud workspaces will be yours. You can close this tab.`)
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
  if (error instanceof EnvironmentError) {
    return environmentErrorResponse(error)
  }
  if (error instanceof WorkspaceError) {
    return fail(error.code, WORKSPACE_ERROR_STATUS[error.code], error.reason)
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
  if (error instanceof DesktopCommandError) {
    return error.code === 'desktop_not_installed'
      ? fail('conflict', 409, error.code)
      : fail('provider_unavailable', 502, error.code)
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
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Every minute: routines (schedule slots, run polling). Every fifth minute: everything else.
    ctx.waitUntil(
      lifecycleDeps(env, {}).then(async (life) => {
        if (life) {
          const tick = await tickRoutines({ life }).catch((error: unknown) => ({ error: String(error).slice(0, 200) }))
          if (Object.values(tick).some((value) => value !== 0)) {
            console.log(JSON.stringify({ event: 'routines_tick', ...tick }))
          }
        }
      })
    )
    // Environment builds: every minute and on their own, so a failing reconcile never stalls one.
    // Advances what nobody watches and re-arms each build's runner in case one was lost.
    ctx.waitUntil(
      lifecycleDeps(env, {}).then(async (life) => {
        if (!life) {
          return
        }
        const deps = buildDeps(life, {}, env)
        const builds = await advanceAllBuilds(deps).catch(() => 0)
        if (builds > 0) {
          console.log(JSON.stringify({ event: 'environment_builds_advanced', builds }))
        }
        for (const build of await unfinishedBuilds(env.SANDBOX_DB).catch(() => [])) {
          await deps.schedule?.({ id: build.id, environmentId: build.environment_id }).catch(() => undefined)
        }
      })
    )
    if (new Date(controller.scheduledTime).getUTCMinutes() % 5 !== 0) {
      return
    }
    ctx.waitUntil(
      lifecycleDeps(env, {}).then(async (life) => {
        if (life) {
          // Counts only; no ids, tokens or pairing material.
          const summary = await reconcile(life)
          console.log(JSON.stringify({ event: 'reconcile', ...summary }))
          const retried = await retryPendingMessages(life).catch(() => -1)
          if (retried !== 0) {
            console.log(JSON.stringify({ event: 'message_retry', retried }))
          }
        }
        // Abandoned MCP client registrations and dead OAuth codes/approvals.
        const purged = await purgeOAuth(env.SANDBOX_DB, Date.now()).catch(() => -1)
        if (purged !== 0) {
          console.log(JSON.stringify({ event: 'oauth_purge', purged }))
        }
        await advanceGoldenImagesFromEnv(env).catch((error: unknown) =>
          console.log(JSON.stringify({ event: 'golden_image_tick_failed', error: String(error).slice(0, 200) }))
        )
        // After the golden tick, with fresh deps: a just-activated image replaces pooled VMs this tick.
        // Runs with the pool off too: that is how a size change to 0 or the kill switch drains it.
        const fresh = await lifecycleDeps(env, {})
        if (fresh) {
          const pool = await maintainPool(fresh).catch((error: unknown) => ({ error: String(error).slice(0, 200) }))
          console.log(JSON.stringify({ event: 'pool', ...pool }))
        }
      })
    )
  }
} satisfies ExportedHandler<Env>

/**
 * One per environment build: wakes on an alarm, advances the build one step (finalize, snapshot,
 * smoke boot, billing all run here) and re-arms until the build is final. Builds therefore finish
 * with no client watching, at most a few seconds after their VM command ends.
 */
export class EnvironmentBuildRunner implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { id?: string; environmentId?: string } | null
    if (!body?.id || !body.environmentId) {
      return new Response('bad request', { status: 400 })
    }
    await this.state.storage.put('build', { id: body.id, environmentId: body.environmentId })
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + 2_000)
    }
    return new Response(null, { status: 204 })
  }

  async alarm(): Promise<void> {
    const build = await this.state.storage.get<{ id: string; environmentId: string }>('build')
    const life = build ? await lifecycleDeps(this.env, {}) : null
    if (!build || !life) {
      await this.state.storage.deleteAll()
      return
    }
    let next: number | null
    try {
      next = await tickBuild(buildDeps(life, {}, this.env), build.environmentId, build.id)
    } catch (error) {
      console.log(JSON.stringify({ event: 'environment_build_tick_failed', buildId: build.id, error: String(error).slice(0, 200) }))
      next = 15_000
    }
    if (next === null) {
      await this.state.storage.deleteAll()
      return
    }
    await this.state.storage.setAlarm(Date.now() + next)
  }
}
