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
//   GET    /v1/sandboxes/boot-plan?repo=<url>                     -> {repo: 'clone' | 'update'}
//   GET    /v1/sandboxes/:id/clone                                -> {clone: {state, percent?, stage?, reason?}}
//   POST   /v1/sandboxes/:id/archive {pullRequests?, checkouts?}  -> {sandbox}
//   GET    /v1/sandboxes/:id/archive                              -> {archive}
//   POST   /v1/sandboxes/:id/unarchive                            -> {sandbox, connection}
//   DELETE /v1/sandboxes/:id                                      -> {sandbox}
//   POST, GET /v1/sandboxes/:id/shares | DELETE /v1/sandboxes/:id/shares/:shareId | POST /v1/shares/:token/visit
//   POST | DELETE /v1/sandboxes/:id/ssh-keys {publicKey}          -> {ssh: {port, user, hostKey}}
//   GET /v1/secrets?scope= | PUT, DELETE /v1/secrets/:scope/:NAME     (see src/secrets.ts)
//   POST   /v1/github/connect -> {installUrl, authorizeUrl}  (bind a GitHub App installation to the account)
//   GET    /v1/github/installations                          -> {installations}
//   GET    /v1/github/repo-access?repo= | /v1/github/repositories   (see src/github-repo-access.ts)
//   /v1/environments[/...]  org environments + versioned builds (see src/environment-routes.ts)
//   POST   /v1/device-sessions | GET | DELETE /:id  per-phone access (see device-sessions.ts)
// Phones sign their own EdDSA tokens (device-sessions.ts) and act as their user, except that they
// cannot enroll devices, manage secrets or connect GitHub.
//   /v1/team/workspaces[/:id[/presence|wake|lease|grants[/:grantId]]], /v1/team/links/resolve, /v1/team/prompts,
//   /v1/team/prefs (src/workspace-prefs.ts), /v1/team/org (src/org-slugs.ts)
//          team workspace registry, presence, per-device grants (src/workspaces.ts, src/grants.ts)
//          POST /v1/team/workspaces/:id/wake?wait=30s: any member who can open it wakes it (single-flight,
//          billed to the account, counted on the owner's seat like every wake) -> {state, endpoint: null, …}
//   /v1/team/members/:userId/(profile|poke), /v1/team/pokes[/settings|/seen]
//          teammate profiles (usage heatmap, recent workspaces) and opt-in Pokes (src/team-presence.ts)
// /v1/sandboxes/* is the owner's lifecycle API: only the workspace's owner (and, for suspend and
// destroy, an org admin) can reach a row there, because resume hands back an orcad pairing offer.
// Browser (GitHub redirects): GET /v1/github/setup, GET /v1/github/callback
// Operator (OPERATOR_TOKEN): /v1/internal/* (see operator.ts)
// Public share links (src/share-gateway.ts): /s/<token>/*, plus the root-path cookie fallback
// Vercel network-policy forwardURL target (Vercel sandbox OIDC):  /v1/egress/proxy
import { purgeTeamSecrets, teamDeleteRoute, teamWorkspaceCount } from './team-delete'
import { ReadSnapshotRouteError, getReadSnapshot, handleReaderKeysRoute, pruneReadSnapshotToOwner, revokeDeviceSessionReaderKeys } from './read-snapshots'
import { refreshStaleEnvironments } from './environment-golden-refresh'
import { ORCA_CLOUD_IDLE_SLEEP_MINUTES } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { z } from 'zod'
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { RunnerBuild } from './build-runner'
import { maintainPool, poolConfigFromEnv } from './pool'
import { cachedCreateTiming } from './create-timing'
import { creatorLeftAccount, tokenMintedBeforeMemberChange } from './member-changes'
import { authenticateDesktop, OrgMismatchError } from './auth'
import { authenticateApi } from './api/caller'
import { handleApi, handleApiAs, isApiPath, type ApiContext, type ApiExtension } from './api/router'
import { handleMcpRoutes, isMcpPath, oauthApprovalsApi, oauthGrantsApi } from './mcp'
import { purgeOAuth } from './mcp/oauth'
import { retryPendingMessages } from './api/messages'
import { revokeWorkspaceTokens } from './api/keys'
import { provisionWorkspaceToken } from './api/settings'
import { docsPage, openApiDocument } from './api/openapi'
import { handleDeviceSessionsRoute } from './device-sessions'
import { removeMember } from './member-removal'
import { setFollow } from './workspace-follows'
import { createRoutinesApi } from './routines/api'
import { handleRoutineHook, isRoutineHookPath } from './routines/hooks'
import { tickRoutines } from './routines/runs'
import { activeGoldenSnapshots, advanceGoldenImages } from './golden-images'
import { sandboxRegions, seedRegion } from './regions'
import { handleRuntimeBundleRoute, runtimeBundleFor, runtimeBundleUrl } from './runtime-bundles'
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
  githubPlaceholderToken,
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
  installerFromIdentity,
  SETUP_SESSION_ID,
  installUrl,
  isInstallationBound,
  listAccountInstallations,
  type GitHubConnectConfig,
  type OAuthIdentity
} from './github-connect'
import { GuardrailError, consumeCreateToken, guardrailsFromEnv } from './guardrails'
import { handleOperator, isOperator } from './operator'
import {
  RepoAccessError,
  billingSetupNotifier,
  billingTrialNotifier,
  handleInstallationEvent,
  listAccountRepositories,
  noticeAfterReturn,
  repoAccess,
  repoAccessView,
  repoInstallUrl,
  type RepoAccessDeps,
  type SetupNotifier,
  type TrialGitHubNotifier
} from './github-repo-access'
import { DEFAULT_RETENTION, type RetentionConfig } from './retention'
import { reconcile } from './reconcile'
import { egressAccountRoutes, egressSecretHosts, placeholderValues, secretPlaceholder } from './secret-egress'
import { SecretError, handleSecretsRoute, keyringFor, type SecretChange } from './secrets'
import { SecretsKmsError } from './secrets-kms'
import { refreshAfterSecretChange, refreshSandboxEnv } from './env-refresh'
import { ACCOUNT_PROVIDERS, accountProvider, isSharedWorkspace } from './account-providers'
import { handleAccountRequestSucceeded, handleAccountUnauthorized, verifyAccountCredential } from './agent-credential-checks'
import { codexBrokerTick, handleCodexBrokerRoute, type BrokerDeps } from './codex-broker'
import { refreshCodexLeases } from './codex-credentials'
import {
  AgentCredentialError,
  PutClaudeSchema,
  agentCredentialsView,
  deleteAgentCredential,
  providerEnabled,
  putClaudeCredential,
  readUsableAgentCredentialState
} from './agent-credentials'
import {
  AgentSourceError,
  PutOfferSchema,
  PutSourceSchema,
  agentSourcesView,
  putAgentSource,
  putOfferAnswer,
  runningSandboxesForDefault
} from './agent-sources'
import { EgressHostsSchema, egressUserHosts, normalizeUserHosts, setEgressUserHosts } from './egress-hosts'
import { gitBasicAuthorization, parseEgressPreset } from './network-policy'
import { cachedProviderEnv } from './session-env'
import { credentialTargets, type CredentialTarget } from './provider-env'
import type { Keyring } from './secrets-crypto'
import { ProviderError, type SandboxProviderApi } from './sandbox-provider'
import { readCloneStatus } from './clone-status'
import { readIdempotencyKey, withIdempotency } from './api/idempotency'
import { ApiError } from './api/caller'
import { ensureAutoEnvironment, expireAutoEnvironments, touchEnvironment } from './auto-environments'
import { DesktopCommandError, VmCommandError, startDesktop } from './sandbox-vm-commands'
import { forgetShareLink, handleShareGateway } from './share-gateway'
import { handleShareRoute, revokeSandboxShares, sharePathMode, shareSecret, shareSecrets } from './share-links'
import { SshKeyRequestSchema, updateSshKey } from './ssh-access'
import { audit, auditSession } from './api/audit'
import { ALL_EVENT_FAMILIES, AUTH_EVENT_FAMILIES, AuditIngestError, AuditIngestSchema, BILLING_EVENT_FAMILIES, ingestAuditEvents } from './api/audit-ingest'
import { getSandbox, getSandboxByProviderName, listAccountSandboxes, markUserSlept, type SandboxRow } from './store'
import { createVercelSandboxApi } from './vercel-sandbox-api'
import { advanceAllBuilds, tickBuild, unfinishedBuilds, type BuildDeps } from './environment-builds'
import { environmentErrorResponse, handleEnvironmentRoute, isEnvironmentRoute } from './environment-routes'
import { EnvironmentError, resolveEnvironmentBoot } from './environments'
import type { GoldenImageProviderApi } from './golden-image-provider'
import { CreateRequestSchema, LeaseRequestSchema, parseWakeWait, readyView, sandboxView } from './wire'
import { ArchiveRequestSchema } from './sandbox-vm-inspect'
import {
  restoreArchivedToSleeping,
  archiveSandbox,
  DEFAULT_ARCHIVE_TTL_MS,
  readArchive,
  restartSandbox,
  unarchiveSandbox,
  wakeHints,
  wakeSandbox,
  workspaceStatus,
  type WorkspaceConfig
} from './workspace-lifecycle'
import {
  GrantRequestSchema,
  issueGrant,
  listGrants,
  recordOwnerDeviceAndSync,
  recordOwnerDeviceForCreate,
  revokeForAccessChange,
  revokeGrantsForDeviceSession,
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
import { egressAllowlistSetting, PlatformHostSuffixesConfigError } from './network-policy'
import { getWorkspacePrefs, putWorkspacePrefs } from './workspace-prefs'
import { getOrgSlug, putOrgSlug } from './org-slugs'
import {
  LinkOtherOrgError,
  PatchSchema,
  PresenceSchema,
  WORKSPACE_ERROR_STATUS,
  WorkspaceError,
  canOpen,
  canSee,
  isOrgAdmin,
  listWorkspaces,
  patchWorkspace,
  assertCanManageWorkspace,
  reportPresence,
  requireVisible,
  resolveLink,
  workspaceViews
} from './workspaces'
import { MemberNamesSchema, rememberMemberNames, rememberCallerName } from './member-names'
import { TeamPresenceError, teamPresenceRoute } from './team-presence'
import { sweepSessionCpu } from './session-cpu'
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
  /** auth.openai.com token calls of the Codex lease refresher (tests). */
  codexTokenFetch?: typeof fetch
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
  /** Billing setup-session notices (tests collect them). */
  setupNotifier?: SetupNotifier
  /** Billing trial abuse-key notices after a bind (tests collect them). */
  trialNotifier?: TrialGitHubNotifier
}

/**
 * RESUME-STUCK: a wake outlives its request. A client that quits mid-wake cancels the request, not
 * the wake (ctx.waitUntil), so the row reaches `running` (or back to `suspended`) instead of
 * staying `resuming`.
 */
function outlivingRequest<T>(life: LifecycleDeps, work: Promise<T>): Promise<T> {
  life.background?.(work.catch(() => undefined))
  return work
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

/** Where golden builds upload their runtime bundle (ENV-STALE); absent when not configured. */
function runtimeBundleConfig(env: Env): { baseUrl: string; secret: string } | undefined {
  const baseUrl = publicOrigin(env)
  return env.RUNTIME_BUNDLES && env.CONTROL_PLANE_TOKEN && baseUrl ? { baseUrl, secret: env.CONTROL_PLANE_TOKEN } : undefined
}

/** The region's active golden as a runtime bundle plus a short-lived download URL (ENV-STALE boot step). */
function runtimeRefreshFor(env: Env): LifecycleDeps['runtimeRefresh'] {
  const config = runtimeBundleConfig(env)
  const store = env.RUNTIME_BUNDLES
  if (!config || !store || env.RUNTIME_REFRESH === 'off') {
    return undefined
  }
  return async (region, now) => {
    const active = await env.SANDBOX_DB.prepare(
      `SELECT bundle_sha256 FROM golden_images WHERE region = ? AND status = 'active' ORDER BY activated_at DESC LIMIT 1`
    )
      .bind(region)
      .first<{ bundle_sha256: string | null }>()
    const commit = active?.bundle_sha256?.startsWith('git:') ? active.bundle_sha256.slice('git:'.length) : null
    const bundle = commit ? await runtimeBundleFor(store, commit) : null
    return bundle ? { bundle, url: await runtimeBundleUrl(config.baseUrl, config.secret, 'GET', bundle.commit, now) } : null
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
  const broker = deps.credentials ?? egressCredentials(env, deps.github ?? githubMinter(env))
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
  const secretRoutes = (row: SandboxRow, host: string): ProxiedRoute[] => {
    const entries = egressSecretHosts(row).filter((candidate) => candidate.host === host)
    const keyring = keyringFor(env)
    if (entries.length === 0 || !keyring) {
      return []
    }
    return entries.flatMap((entry) =>
      Object.entries(entry.headers).map(([header, format]): ProxiedRoute => ({
        header,
        placeholders: placeholderValues(entry, header, secretPlaceholder(row, entry.secret)),
        label: entry.secret,
        ...(entry.paths ? { pathAllowed: requestMatches(entry.paths) } : {}),
        ...(entry.keepResponseFields ? { keepResponseFields: entry.keepResponseFields } : {}),
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
  // D10/D13: re-decided per request, so a Source change, renewal, revocation, kill switch or the workspace
  // becoming shared applies to the next request with no restart.
  const accountRoutes = (row: SandboxRow, host: string): ProxiedRoute[] =>
    egressAccountRoutes(row)
      .filter((route) => route.host === host)
      .flatMap(({ agent, owner }) => {
        const provider = accountProvider(agent)
        const keyring = keyringFor(env)
        if (!provider || !keyring) {
          return []
        }
        let real: string | null = null
        // RS-2: this sign-in is in question (a check failed); a real request here confirms or clears it.
        let suspect = false
        return [
          {
            header: provider.header,
            placeholders: [provider.format(provider.placeholder(row))],
            label: `account:${agent}`,
            ...(provider.pathAllowed ? { pathAllowed: provider.pathAllowed } : {}),
            credential: async () => {
              // The agent sees the provider's own "sign in again" answer, not a proxy error.
              const signedOut = (reason: string) => ({ deny: reason, ...(provider.signedOut ? { answer: provider.signedOut } : {}) })
              const now = (deps.now ?? Date.now)()
              // The session was set up for this owner; a workspace handed to someone else never uses
              // the new owner's account until its env is rebuilt for them.
              if (owner !== row.user_id) {
                scheduleEnvRefresh(env, deps, row)
                return signedOut('account_owner_changed')
              }
              if (isSharedWorkspace(row)) {
                scheduleEnvRefresh(env, deps, row)
                return signedOut('account_not_shared')
              }
              if (!providerEnabled(env)[agent]) {
                scheduleEnvRefresh(env, deps, row)
                return signedOut('account_disabled')
              }
              const account = await cachedAccountCredential(env.SANDBOX_DB, await keyring, row.user_id, agent, now)
              real = account.value
              suspect = account.suspect
              if (!real) {
                scheduleEnvRefresh(env, deps, row)
                return signedOut('no_agent_credential')
              }
              return provider.format(real)
            },
            ...(provider.extraHeaders ? { extraHeaders: () => (real ? provider.extraHeaders!(real) : {}) } : {}),
            // Reached only after the real credential was swapped in and sent (denied or unswapped requests
            // never get here).
            onUpstreamStatus: (status, request) => {
              // RS-2: a real request the provider accepted (not a 401, not a server failure) clears "needs
              // check". Only while it's in question, so a healthy account costs no writes.
              if (suspect && !provider.onUnauthorized && status !== 401 && status < 500) {
                suspect = false
                const now = (deps.now ?? Date.now)()
                const work = handleAccountRequestSucceeded({
                  db: env.SANDBOX_DB,
                  agent,
                  userId: row.user_id,
                  sandboxId: row.id,
                  path: request.path,
                  now
                }).then((cleared) => (cleared ? forgetAccountCredential(row.user_id, agent) : undefined))
                if (deps.waitUntil) {
                  deps.waitUntil(work.catch(() => undefined))
                } else {
                  void work.catch(() => undefined)
                }
              }
              if (status === 401) {
                const now = (deps.now ?? Date.now)()
                const waitUntil = (work: Promise<unknown>) => (deps.waitUntil ? deps.waitUntil(work.catch(() => undefined)) : void work.catch(() => undefined))
                // Codex refreshes its lease (which marks the login dead itself); everyone else confirms with one
                // auth check before revoking, so a transient 401 never signs the person out everywhere.
                const handled: Promise<boolean> = provider.onUnauthorized
                  ? keyring.then((ring) => provider.onUnauthorized!({ db: env.SANDBOX_DB, keyring: ring, userId: row.user_id, now, waitUntil })).then(() => true)
                  : keyring
                      .then((ring) =>
                        handleAccountUnauthorized({
                          db: env.SANDBOX_DB,
                          keyring: ring,
                          provider,
                          userId: row.user_id,
                          sandboxId: row.id,
                          path: request.path,
                          now,
                          fetch: deps.egressFetch ?? fetch
                        })
                      )
                      .then((outcome) => {
                        // In question, not revoked: still usable; the next lookup reads the new state.
                        if (outcome === 'suspect') {
                          forgetAccountCredential(row.user_id, agent)
                        }
                        return outcome === 'revoked'
                      })
                // Every running sandbox of this person drops the dead placeholder, not only this one.
                const work = handled.then(async (changed) => {
                  if (!changed) {
                    return
                  }
                  forgetAccountCredential(row.user_id, agent)
                  await refreshOwnersSandboxes(env, deps, row.user_id)
                })
                if (deps.waitUntil) {
                  deps.waitUntil(work.catch(() => undefined))
                } else {
                  void work.catch(() => undefined)
                }
              }
            }
          }
        ]
      })
  // An account that stopped applying (revoked, expired, removed, turned off) leaves its placeholder in shells
  // and agents already running, and Vercel may still forward for a moment: answer those requests the way the
  // provider answers a dead token, never with a proxy error. Nothing is swapped on these routes.
  const signedOutRoutes = (row: SandboxRow, host: string): ProxiedRoute[] => {
    const live = new Set(egressAccountRoutes(row).filter((route) => route.host === host).map((route) => route.agent))
    return ACCOUNT_PROVIDERS.filter((provider) => provider.signedOut && provider.hosts.includes(host) && !live.has(provider.agent)).map(
      (provider) => ({
        header: provider.header,
        placeholders: [provider.format(provider.placeholder(row))],
        label: `account:${provider.agent}:signed-out`,
        credential: async () => ({ deny: 'account_signed_out', answer: provider.signedOut! })
      })
    )
  }
  return async (row, host) => {
    if (host === 'github.com') {
      return [
        // Members first: a member placeholder must never fall through to the app's token.
        ...(await members.routes(row, host)),
        // git over HTTPS with the workspace placeholder: the app's installation token for this repo.
        { header: 'authorization', placeholders: [gitBasicAuthorization(githubPlaceholderToken(row))], credential: () => broker.authorizationFor(row, host) }
      ]
    }
    if (host === 'api.github.com') {
      return [
        // Members first: a member placeholder must never fall through to the app's token.
        ...(await members.routes(row, host)),
        { header: 'authorization', placeholders: githubPlaceholderHeaders(row), credential: () => broker.authorizationFor(row, host) },
        // A user's own GitHub token for Copilot CLI (COPILOT_GITHUB_TOKEN), on its own placeholder.
        ...secretRoutes(row, host)
      ]
    }
    return [...accountRoutes(row, host), ...signedOutRoutes(row, host), ...secretRoutes(row, host)]
  }
}

// Account credentials per person, decrypted at most once a minute per isolate; an edit or delete drops it.
const ACCOUNT_CACHE_MS = 10_000
const accountCache = new Map<string, { at: number; value: Promise<{ value: string | null; suspect: boolean }> }>()
function cachedAccountCredential(
  db: D1Database,
  keyring: Keyring,
  userId: string,
  agent: 'claude' | 'codex',
  now: number
): Promise<{ value: string | null; suspect: boolean }> {
  const key = `${userId}:${agent}`
  const hit = accountCache.get(key)
  if (hit && now - hit.at < ACCOUNT_CACHE_MS) {
    return hit.value
  }
  const value = readUsableAgentCredentialState(db, keyring, userId, agent, now)
  accountCache.set(key, { at: now, value })
  value.catch(() => accountCache.delete(key))
  return value
}
export function forgetAccountCredential(userId: string, agent: 'claude' | 'codex'): void {
  accountCache.delete(`${userId}:${agent}`)
}

/** Background env refresh for one sandbox (proxy-side self-healing when its account route stops applying). */
const lastHealRefresh = new Map<string, number>()
function scheduleEnvRefresh(env: Env, deps: Deps, row: SandboxRow): void {
  const now = (deps.now ?? Date.now)()
  if (now - (lastHealRefresh.get(row.id) ?? 0) < 60_000) {
    return
  }
  lastHealRefresh.set(row.id, now)
  if (lastHealRefresh.size > 1000) {
    for (const [id, at] of lastHealRefresh) {
      if (now - at >= 60_000) {
        lastHealRefresh.delete(id)
      }
    }
  }
  const work = lifecycleDeps(env, deps).then((life) => (life ? refreshSandboxEnv(life, row) : false))
  if (deps.waitUntil) {
    deps.waitUntil(work.catch(() => undefined))
  } else {
    void work.catch(() => undefined)
  }
}

/** Running sandboxes of this person whose session env depends on their account credential. */
async function refreshOwnersSandboxes(env: Env, deps: Deps, userId: string): Promise<void> {
  const { results } = await env.SANDBOX_DB.prepare(`SELECT * FROM sandboxes WHERE user_id = ? AND status = 'running' LIMIT 200`).bind(userId).all<SandboxRow>()
  if (results.length === 0) {
    return
  }
  const work = lifecycleDeps(env, deps).then(async (life) => {
    if (life) {
      for (const row of results) {
        await refreshSandboxEnv(life, row).catch(() => false)
      }
    }
  })
  if (deps.waitUntil) {
    deps.waitUntil(work.catch(() => undefined))
  } else {
    await work
  }
}

/** Codex broker (codex-broker.ts): the lifecycle provider and keyring; null when either is missing. */
async function codexBrokerDeps(env: Env, deps: Deps): Promise<BrokerDeps | null> {
  const [life, keyring] = await Promise.all([lifecycleDeps(env, deps), keyringFor(env)])
  if (!life || !keyring) {
    return null
  }
  return {
    life,
    keyring,
    onStored: async (userId) => {
      forgetAccountCredential(userId, 'codex')
      await refreshOwnersSandboxes(env, deps, userId)
    }
  }
}

async function agentCredentialsRoute(request: Request, url: URL, env: Env, deps: Deps, caller: SandboxCaller): Promise<Response> {
  const db = env.SANDBOX_DB
  const now = (deps.now ?? Date.now)()
  const noStore = (body: unknown) => Response.json(body, { headers: { 'cache-control': 'no-store' } })
  const keyring = keyringFor(env)
  if (!keyring) {
    return fail('not_configured', 503)
  }
  try {
    if (request.method === 'GET' && url.pathname === '/v1/agent-credentials') {
      return noStore(await agentCredentialsView(db, env, caller.userId, now))
    }
    if (request.method === 'PUT' && url.pathname === '/v1/agent-credentials/claude') {
      const body = PutClaudeSchema.safeParse(await readJson(request))
      if (!body.success) {
        return fail('invalid_request', 400)
      }
      await putClaudeCredential(db, await keyring, env, caller, body.data, now)
      forgetAccountCredential(caller.userId, 'claude')
      await refreshOwnersSandboxes(env, deps, caller.userId)
      return noStore(await agentCredentialsView(db, env, caller.userId, now))
    }
    // Pre-launch check (desktop): a recent pass answers at once; otherwise one rate-limited auth check with
    // the real token, revoking only on a definite auth failure (agent-credential-checks.ts).
    if (request.method === 'POST' && url.pathname === '/v1/agent-credentials/claude/verify') {
      const provider = accountProvider('claude')
      if (!providerEnabled(env).claude || !provider) {
        return fail('not_found', 404)
      }
      const result = await verifyAccountCredential({
        db,
        keyring: await keyring,
        provider,
        userId: caller.userId,
        now,
        fetch: deps.egressFetch ?? fetch
      })
      if (result.outcome === 'revoked') {
        forgetAccountCredential(caller.userId, 'claude')
        await refreshOwnersSandboxes(env, deps, caller.userId)
      }
      if (result.outcome === 'suspect') {
        forgetAccountCredential(caller.userId, 'claude')
      }
      const view = await agentCredentialsView(db, env, caller.userId, now)
      return noStore({ claude: view.claude, verifiedAt: result.verifiedAt, checked: result.outcome !== 'fresh' && result.outcome !== 'skipped' })
    }
    if (url.pathname === '/v1/agent-credentials/codex/broker' || url.pathname.startsWith('/v1/agent-credentials/codex/broker/')) {
      return await handleCodexBrokerRoute(request, url, { enabled: providerEnabled(env).codex, deps: await codexBrokerDeps(env, deps), caller })
    }
    const del = /^\/v1\/agent-credentials\/(claude|codex)$/.exec(url.pathname)
    if (request.method === 'DELETE' && del) {
      const agent = del[1] as 'claude' | 'codex'
      if (!(await deleteAgentCredential(db, caller.userId, agent))) {
        return fail('not_found', 404)
      }
      forgetAccountCredential(caller.userId, agent)
      console.log(JSON.stringify({ event: 'agent_credential_deleted', agent, by: caller.userId }))
      await refreshOwnersSandboxes(env, deps, caller.userId)
      return noStore(await agentCredentialsView(db, env, caller.userId, now))
    }
    return fail('not_found', 404)
  } catch (error) {
    if (error instanceof AgentCredentialError) {
      return fail(error.code, error.status, error.reason)
    }
    throw error
  }
}

/** Method and path (the query string is ignored); a prefix entry matches below a normalized path only. */
function requestMatches(allowed: NonNullable<CredentialTarget['paths']>): (method: string, path: string) => boolean {
  return (method, path) => {
    const pathname = path.split('?')[0] ?? ''
    // A prefix grant never stretches across encoded or dot segments into another API.
    const plain = /^(\/[A-Za-z0-9._~-]+)+\/?$/.test(pathname) && !/(^|\/)\.\.?(\/|$)/.test(pathname)
    return allowed.some(
      (entry) =>
        entry.method === method.toUpperCase() &&
        (entry.prefix ? plain && pathname.startsWith(entry.path) : entry.path === pathname)
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
    fetch: deps.githubFetch,
    verifyInstaller: async (installationId, user) => {
      const minter = deps.github ?? githubMinter(env)
      return minter ? installerFromIdentity(minter, installationId, user) : null
    }
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

function egressCredentials(env: Env, minter: GitHubAppMinter | undefined): CredentialBroker {
  if (!minter) {
    return devCredentials(env)
  }
  return {
    authorizationFor: async (row, host) => {
      if ((host !== 'api.github.com' && host !== 'github.com') || !row.repo_url) {
        return null
      }
      const minted = await minter.tokenForRepo(row.repo_url, row.account_id)
      if (!minted) {
        return null
      }
      // git sends Basic (x-access-token:<token>); Octokit/gh on the API use Bearer.
      return host === 'github.com' ? gitBasicAuthorization(minted.token) : `Bearer ${minted.token}`
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
function readyResponse(ready: Ready, updateAware = false): Response {
  const response = json(readyView(ready.row, ready.connection, ready.cloning, updateAware))
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
    // Works without provider config too: reading the log needs billing, not a sandbox provider.
    features: (accountId) => {
      const client = resolved?.entitlements ?? deps.entitlements ?? withDevAccountBypass(env, createEntitlementClient(env))
      return client.features?.(accountId) ?? Promise.resolve({ auditLog: false })
    },
    extensions: [oauthApprovalsApi, oauthGrantsApi, routines, ...(deps.apiExtensions ?? [])]
  }
}

/** Lifecycle routes refuse to run half-configured rather than guess at Orca's provider account. */
export async function lifecycleDeps(env: Env, deps: Deps): Promise<LifecycleDeps | null> {
  if (!deps.provider && (!env.VERCEL_TOKEN || !env.VERCEL_TEAM_ID || !env.VERCEL_PROJECT_ID)) {
    return null
  }
  const regions = await goldenRegions(env)
  if (!regions) {
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
  const life: LifecycleDeps = {
    db: env.SANDBOX_DB,
    provider,
    entitlements: deps.entitlements ?? withDevAccountBypass(env, createEntitlementClient(env)),
    github: deps.github ?? githubMinter(env),
    ...(await secretsState(env)),
    memberIdentity: await memberIdentityFor(env, deps),
    now: deps.now ?? Date.now,
    sleep: deps.sleep,
    retention: deps.retention ?? retentionFromEnv(env),
    background: deps.waitUntil,
    publicRepoCheck: deps.publicRepoCheck ?? ((repoUrl) => githubRepoIsPublic(repoUrl)),
    runtimeRefresh: runtimeRefreshFor(env),
    hooks: {
      afterBoot: (row, sessionId) =>
        provisionWorkspaceToken({ db: env.SANDBOX_DB, provider, now: deps.now ?? Date.now, apiUrl: publicOrigin(env) }, row, sessionId),
      afterStop: (row) => revokeWorkspaceTokens(env.SANDBOX_DB, row.id, (deps.now ?? Date.now)())
    },
    config: {
      pool: poolConfigFromEnv(env),
      shareLinkSecret: shareSecret(env),
      ...platformAllowlistConfig(env),
      extraEgressHosts: extraEgressHostsFor(env),
      dockerEnabled: env.SANDBOX_DOCKER?.trim().toLowerCase() !== 'off',
      egressPreset: parseEgressPreset(env.SANDBOX_EGRESS_PRESET),
      guardrails: guardrailsFromEnv(env),
      snapshotExpirationMs:
        env.SNAPSHOT_EXPIRATION_DAYS && Number(env.SNAPSHOT_EXPIRATION_DAYS) >= 1
          ? Math.floor(Number(env.SNAPSHOT_EXPIRATION_DAYS)) * 86_400_000
          : undefined,
      environment: env.SANDBOX_ENV,
      ...regions,
      egressProxyUrl: env.EGRESS_PROXY_URL,
      sessionDeadlineMs:
        env.SESSION_DEADLINE_MS && env.SANDBOX_ENV !== 'prod' ? Number(env.SESSION_DEADLINE_MS) : undefined
    }
  }
  // AUTO_ENVIRONMENTS=off: creates of repos without an environment keep cloning from scratch.
  if (env.AUTO_ENVIRONMENTS !== 'off') {
    life.autoEnvironment = {
      ensure: (accountId, repoUrl) => ensureAutoEnvironment(buildDeps(life, deps, env), accountId, repoUrl),
      touch: (environmentId) => touchEnvironment(env.SANDBOX_DB, environmentId, life.now())
    }
  }
  return life
}

/**
 * Each region's golden image (golden-images.ts rotates one per region; the GOLDEN_SNAPSHOT_ID var only
 * seeds its own region) and the regions new sandboxes may use. The default region is the first of
 * VERCEL_REGION and its fallbacks that has an image: a freshly added default region serves nothing
 * until its first image passes smoke, and creates keep landing in the fallback meanwhile.
 */
async function goldenRegions(
  env: Env
): Promise<Pick<LifecycleDeps['config'], 'goldenSnapshotId' | 'goldenSnapshots' | 'defaultRegion' | 'fallbackRegions'> | null> {
  const wanted = sandboxRegions(env)
  const goldens = await activeGoldenSnapshots(env.SANDBOX_DB)
  const seeded = seedRegion(env)
  if (env.GOLDEN_SNAPSHOT_ID && !goldens[seeded]) {
    goldens[seeded] = env.GOLDEN_SNAPSHOT_ID
  }
  const usable = wanted.filter((region) => goldens[region])
  const defaultRegion = usable[0]
  if (!defaultRegion) {
    return null
  }
  // Preview versions in dev may pin an image under test (shared D1's active image is the live one);
  // the pin replaces the default region's image, so it must be a snapshot taken in that region.
  const override = env.SANDBOX_ENV !== 'prod' ? env.GOLDEN_SNAPSHOT_OVERRIDE : undefined
  if (override) {
    goldens[defaultRegion] = override
  }
  return { goldenSnapshotId: goldens[defaultRegion]!, goldenSnapshots: goldens, defaultRegion, fallbackRegions: usable.slice(1) }
}

/**
 * Arms the build's runner: one Durable Object per build, hosted by the build runner Worker
 * (src/build-runner.ts). A no-op where the binding is absent.
 */
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
      goldenSnapshots: life.config.goldenSnapshots,
      region: life.config.defaultRegion,
      guardrails: life.config.guardrails,
      egressAllowlist: life.config.egressAllowlist,
      egressAllowlistError: life.config.egressAllowlistError
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

/**
 * Keeps a smoke-tested golden image current in every sandbox region (default and fallbacks): refresh
 * before expiry, rebuild on a new release or VM-touching commit. Regions advance independently.
 */
async function advanceGoldenImagesFromEnv(env: Env): Promise<void> {
  const platform = egressAllowlistSetting(env.ORCA_PLATFORM_HOST_SUFFIXES)
  if (platform.error) {
    // The smoke boots under this list: no rotation until it is fixed (the active image keeps serving).
    console.error(JSON.stringify({ event: 'config_error', variable: 'ORCA_PLATFORM_HOST_SUFFIXES', invalid: platform.error.invalid, skipped: 'golden_images' }))
    return
  }
  if (!env.VERCEL_TOKEN || !env.VERCEL_TEAM_ID || !env.VERCEL_PROJECT_ID) {
    return
  }
  const days = Number(env.GOLDEN_SNAPSHOT_EXPIRATION_DAYS ?? '0')
  const provider = createVercelSandboxApi({
    token: env.VERCEL_TOKEN,
    teamId: env.VERCEL_TEAM_ID,
    projectId: env.VERCEL_PROJECT_ID,
    baseUrl: env.VERCEL_API_BASE
  })
  const github = githubMinter(env)?.sourceRequest
  const seeded = seedRegion(env)
  await Promise.all(
    sandboxRegions(env).map(async (region) => {
      try {
        const tick = await advanceGoldenImages({
          db: env.SANDBOX_DB,
          provider,
          now: Date.now,
          config: {
            environment: env.SANDBOX_ENV,
            region,
            expirationMs: Number.isFinite(days) && days >= 1 ? Math.floor(days) * 86_400_000 : 0,
            source: env.GOLDEN_IMAGE_SOURCE,
            github,
            seedSnapshotId: region === seeded ? env.GOLDEN_SNAPSHOT_ID : undefined,
            refreshBeforeMs: env.GOLDEN_REFRESH_BEFORE_HOURS ? Number(env.GOLDEN_REFRESH_BEFORE_HOURS) * 3_600_000 : undefined,
            runtimeBundle: runtimeBundleConfig(env),
            egressAllowlist: platform.allowlist
          }
        })
        if (tick !== 'idle') {
          console.log(JSON.stringify({ event: 'golden_image_tick', region, tick }))
        }
      } catch (error) {
        // One region's trouble must not stall another's rotation.
        console.log(JSON.stringify({ event: 'golden_image_tick_failed', region, error: String(error).slice(0, 200) }))
      }
    })
  )
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

async function secretsState(env: Env): Promise<Pick<LifecycleDeps, 'secrets' | 'secretsUnavailable'>> {
  const keyring = keyringFor(env)
  if (!keyring) {
    return {}
  }
  try {
    return { secrets: { keyring: await keyring, ...secretsEgressMode(env), accountProviders: providerEnabled(env) } }
  } catch (error) {
    if (error instanceof SecretsKmsError) {
      // KMS holds the keys and is not handing them over. Routes that need no secrets keep working;
      // a session start and the secrets routes answer 503 (keyringFor logged the reason).
      return { secretsUnavailable: error.reason }
    }
    // A malformed KEK must not block sandbox starts; the secrets routes surface it as 503.
    console.log(JSON.stringify({ event: 'secrets_kek_invalid' }))
    return {}
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
  try {
    return await routeRequest(request, env, deps)
  } catch (error) {
    if (error instanceof PlatformHostSuffixesConfigError) {
      return platformHostsMisconfigured(error)
    }
    // A stale-org token anywhere in routing (ORG-TOKEN-STALE): the desktop re-mints once and retries.
    if (error instanceof OrgMismatchError) {
      return orgMismatchResponse()
    }
    throw error
  }
}

/** The lifecycle's base allowlist, or the config error that refuses limited-mode policy compiles. */
function platformAllowlistConfig(env: Env): { egressAllowlist?: readonly string[]; egressAllowlistError?: PlatformHostSuffixesConfigError } {
  const { allowlist, error } = egressAllowlistSetting(env.ORCA_PLATFORM_HOST_SUFFIXES)
  return error ? { egressAllowlistError: error } : { egressAllowlist: allowlist }
}

/** 503 for whatever needs the platform host list (creates, wakes, builds, health), naming the bad entries. */
function platformHostsMisconfigured(error: PlatformHostSuffixesConfigError): Response {
  console.error(JSON.stringify({ event: 'config_error', variable: 'ORCA_PLATFORM_HOST_SUFFIXES', invalid: error.invalid }))
  // Code only: /v1/health is public, so the bad entries stay in the log line above.
  return json({ error: 'platform_hosts_misconfigured' }, 503)
}

function orgMismatchResponse(): Response {
  return json(
    {
      error: 'org_mismatch',
      reason: 'org_mismatch',
      message: 'Orca Cloud signed you in for a different team. Try again.'
    },
    409
  )
}

async function routeRequest(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url)
  try {
    const shared = await shareGateway(request, url, env, deps)
    if (shared) {
      return shared
    }
    // Signed by the control plane (no bearer): golden builds upload, booting sandboxes download.
    const bundle = await handleRuntimeBundleRoute(request, url, {
      store: env.RUNTIME_BUNDLES,
      secret: env.CONTROL_PLANE_TOKEN,
      now: (deps.now ?? Date.now)()
    })
    if (bundle) {
      return bundle
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
      return await handleRoutineHook(request, url, {
        db: env.SANDBOX_DB,
        now: deps.now ?? Date.now,
        githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
        onInstallationEvent: (eventName, payload) =>
          handleInstallationEvent(
            { db: env.SANDBOX_DB, now: (deps.now ?? Date.now)(), notify: setupNotifier(env, deps), notifyTrial: trialNotifier(env, deps) },
            eventName,
            payload as Parameters<typeof handleInstallationEvent>[2]
          )
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
    if (url.pathname === '/v1/internal/github/install-url' && request.method === 'GET') {
      // Billing's cloud setup chain (shared CONTROL_PLANE_TOKEN, not the operator token).
      if (!(await isOperator(request, env.CONTROL_PLANE_TOKEN))) {
        return fail('not_found', 404)
      }
      return await internalInstallUrl(env, deps, url)
    }
    if (url.pathname.startsWith('/v1/internal/')) {
      // Auth's token (MEMBER_REMOVED_TOKEN) is good for its own routes only: the member-removed and
      // role-changed pushes and deleting a team. Never the other operator routes.
      const teamDelete = teamDeleteRoute(url.pathname, request.method)
      // Append-only events from auth for the team audit log (api/audit-ingest.ts).
      const auditIngest = url.pathname === '/v1/internal/audit-events' && request.method === 'POST'
      const memberPush =
        request.method === 'POST' && (url.pathname === '/v1/internal/org-members/removed' || url.pathname === '/v1/internal/members/role-changed')
      // Display names for a team's members, as labels (member-names.ts).
      const memberNames = url.pathname === '/v1/internal/member-names' && request.method === 'POST'
      const authOnly = (memberPush || teamDelete !== null || auditIngest || memberNames) && (await isOperator(request, env.MEMBER_REMOVED_TOKEN))
      // Billing's bearer (CONTROL_PLANE_TOKEN) reaches this one route, for billing events only.
      const billingOnly = !authOnly && auditIngest && (await isOperator(request, env.CONTROL_PLANE_TOKEN))
      if (!authOnly && !billingOnly && !(await isOperator(request, env.OPERATOR_TOKEN))) {
        return fail('not_found', 404)
      }
      if (memberNames) {
        const body = MemberNamesSchema.safeParse(await readJson(request, MAX_API_JSON_BYTES))
        if (!body.success) {
          return fail('invalid_request', 400)
        }
        return json({ saved: await rememberMemberNames(env.SANDBOX_DB, body.data, (deps.now ?? Date.now)()) })
      }
      if (auditIngest) {
        // Append-only, and needs no sandbox provider: events from auth and billing for the team audit log.
        const body = AuditIngestSchema.safeParse(await readJson(request, MAX_API_JSON_BYTES))
        if (!body.success) {
          return fail('invalid_request', 400)
        }
        try {
          const families = authOnly ? AUTH_EVENT_FAMILIES : billingOnly ? BILLING_EVENT_FAMILIES : ALL_EVENT_FAMILIES
          return json(await ingestAuditEvents(env.SANDBOX_DB, body.data, (deps.now ?? Date.now)(), families))
        } catch (error) {
          if (error instanceof AuditIngestError) {
            return fail('invalid_request', 400, error.message)
          }
          throw error
        }
      }
      if (teamDelete) {
        if (teamDelete.action === 'delete-check') {
          return json({ workspaces: await teamWorkspaceCount(env.SANDBOX_DB, teamDelete.accountId) })
        }
        const purged = await purgeTeamSecrets(env.SANDBOX_DB, teamDelete.accountId)
        return purged.ok
          ? json({ purged: purged.purged })
          : json({ error: 'workspaces_exist', workspaces: purged.workspaces }, 409)
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
        // Auth pushes this when a member leaves or is removed: everything of theirs stops acting for them.
        const body = MemberRemovedSchema.safeParse(await readJson(request))
        if (!body.success) {
          return fail('invalid_request', 400)
        }
        // Same cleanup as /v1/internal/members/removed: keys, phones, workspace grants and routines.
        const removal = await removeMember(life, body.data.accountId, body.data.userId, life.now(), body.data.changedAt, body.data.actorUserId)
        return json({ revoked: removal.grantsRevoked, queued: removal.grantsQueued, ...removal })
      }
      return (
        (await handleOperator(request, url.pathname, {
          life,
          github: deps.github ?? githubMinter(env),
          readJson: () => readJson(request),
          keyring: () => keyringFor(env)
        })) ?? fail('not_found', 404)
      )
    }
    if (url.pathname === '/v1/health' && request.method === 'GET') {
      // Post-deploy smoke: no auth, no DB. 503 names a config error a deploy must not ship.
      const platform = egressAllowlistSetting(env.ORCA_PLATFORM_HOST_SUFFIXES)
      return platform.error ? platformHostsMisconfigured(platform.error) : json({ ok: true }, 200)
    }
    if (url.pathname === '/v1/config' && request.method === 'GET') {
      // Public product constants (no auth): every client reads these instead of hardcoding them.
      const createTiming = await cachedCreateTiming(env.SANDBOX_DB, (deps.now ?? Date.now)())
      const config = workspaceConfig(env, deps)
      return Response.json(
        {
          idleSleepMinutes: config.idleSleepMinutes ?? ORCA_CLOUD_IDLE_SLEEP_MINUTES,
          archiveTtlDays: Math.round((config.archiveTtlMs ?? DEFAULT_ARCHIVE_TTL_MS) / 86_400_000),
          ...(createTiming ? { createTiming } : {})
        },
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
    if (url.pathname === '/v1/reader-keys' || url.pathname.startsWith('/v1/reader-keys/')) {
      const now = (deps.now ?? Date.now)()
      const caller = await authenticateDesktop(env, request, now)
      if (!caller) {
        return fail('unauthorized', 401)
      }
      return await handleReaderKeysRoute(request, url, { db: env.SANDBOX_DB, caller, now, readJson: () => readJson(request) })
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
            // Its reader key: independent of the grant cleanup below, so neither failure blocks the other.
            await revokeDeviceSessionReaderKeys(env.SANDBOX_DB, deviceSessionId, now).catch((error: unknown) =>
              console.log(JSON.stringify({ event: 'device_reader_key_revoke_failed', id: deviceSessionId, error: String(error).slice(0, 120) }))
            )
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
    if (url.pathname === '/v1/github/repo-access' || url.pathname === '/v1/github/repositories') {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      if (caller.deviceSessionId) {
        return fail('forbidden', 403, 'device_session')
      }
      if (await tokenMintedBeforeMemberChange(env.SANDBOX_DB, caller)) {
        // ORG-TOKEN-STALE: minted before this member's role changed; the desktop re-mints and retries.
        return fail('unauthorized', 401, 'stale_token')
      }
      if (request.method !== 'GET') {
        return fail('not_found', 404)
      }
      try {
        if (url.pathname === '/v1/github/repositories') {
          return json(await listAccountRepositories(repoAccessDeps(env, deps), caller.accountId, url.searchParams.get('cursor')))
        }
        const view = await repoAccessView(repoAccessDeps(env, deps), caller, url)
        return json(view.body, view.status)
      } catch (error) {
        if (error instanceof RepoAccessError) {
          return fail(error.code === 'not_github' ? 'invalid_request' : 'not_configured', error.code === 'not_github' ? 400 : 503, error.code)
        }
        console.log(JSON.stringify({ event: 'github_repo_access_failed', error: String(error).slice(0, 160) }))
        return fail('provider_unavailable', 502, 'github_unavailable')
      }
    }
    if (url.pathname === '/v1/github/connect' || url.pathname === '/v1/github/installations') {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      if (caller.deviceSessionId) {
        return fail('forbidden', 403, 'device_session')
      }
      if (await tokenMintedBeforeMemberChange(env.SANDBOX_DB, caller)) {
        // ORG-TOKEN-STALE: minted before this member's role changed; the desktop re-mints and retries.
        return fail('unauthorized', 401, 'stale_token')
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
      // Optional body: the repository to preselect and the setup session waiting on it.
      const target = ConnectBodySchema.safeParse(request.headers.get('content-length') === '0' ? {} : await readJson(request).catch(() => ({})))
      const repo = target.success && target.data.repo ? parseGitHubRepo(target.data.repo) : null
      if (target.success && repo) {
        const access = repoAccessDeps(env, deps)
        const preselected = await repoInstallUrl(access, caller, target.data.repo!, {
          setupSessionId: target.data.setupSessionId,
          repoId: target.data.repoId,
          ownerId: target.data.ownerId
        })
        return json({ installUrl: preselected.url, authorizeUrl: authorizeUrl(connect, url.origin, preselected.state) })
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
      if (await tokenMintedBeforeMemberChange(env.SANDBOX_DB, caller)) {
        // ORG-TOKEN-STALE: minted before this member's role changed; the desktop re-mints and retries.
        return fail('unauthorized', 401, 'stale_token')
      }
      const { secrets, secretsUnavailable } = await secretsState(env)
      if (secretsUnavailable) {
        return secretsUnavailableResponse()
      }
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
    if (url.pathname === '/v1/agent-credentials' || url.pathname.startsWith('/v1/agent-credentials/')) {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      // Desktop main only: never a phone's device session (and the renderer never holds the token).
      if (caller.deviceSessionId) {
        return fail('forbidden', 403, 'device_session')
      }
      return await agentCredentialsRoute(request, url, env, deps, caller)
    }
    if (url.pathname === '/v1/agent-sources' || url.pathname === '/v1/agent-sources/offer') {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      if (caller.deviceSessionId) {
        return fail('forbidden', 403, 'device_session')
      }
      return await agentSourcesRoute(request, url, env, deps, caller)
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
      url.pathname === '/v1/team/prompts' ||
      url.pathname === '/v1/team/prefs' ||
      url.pathname === '/v1/team/org' ||
      url.pathname.startsWith('/v1/team/members/') ||
      url.pathname === '/v1/team/pokes' ||
      url.pathname.startsWith('/v1/team/pokes/')
    ) {
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      return await workspaceRoute(request, url, env, deps, caller)
    }
    if (url.pathname === '/v1/sandboxes/boot-plan' && request.method === 'GET') {
      // Whether a create of this repo would clone it or update a prebuilt copy, so the desktop names
      // its repository step once, before the create answers (environments.ts resolveEnvironmentBoot).
      const caller = await authenticateDesktop(env, request, (deps.now ?? Date.now)())
      if (!caller) {
        return fail('unauthorized', 401)
      }
      const repo = url.searchParams.get('repo') ?? ''
      if (repo.length === 0 || repo.length > 2048) {
        return fail('invalid_request', 400)
      }
      const source = await resolveEnvironmentBoot(env.SANDBOX_DB, caller.accountId, { repoUrl: repo }).catch(() => null)
      return json({ repo: source?.repoDir ? 'update' : 'clone' })
    }
    const match =
      /^\/v1\/sandboxes(?:\/([A-Za-z0-9_]+)(?:\/(suspend|resume|lease|rollover|wake|restart|status|clone|archive|unarchive|env\/refresh|egress\/hosts|ssh-keys|desktop))?)?$/.exec(
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
    // Predictive wake: the last deliberate sleep and the seat's running count, for clients that ask.
    const wakeHintsAware = features.includes('wake-hints')
    const view = (row: SandboxRow) => sandboxView(row, archivedAware, features.includes('git-setup'))
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
      if (await tokenMintedBeforeMemberChange(life.db, caller)) {
        // ORG-TOKEN-STALE: never create (and bill) with a token minted before a role change.
        return fail('unauthorized', 401, 'stale_token')
      }
      await consumeCreateToken(life.db, life.config.guardrails!, caller.accountId, life.now())
      const raw = await readJson(request)
      const body = CreateRequestSchema.safeParse(raw)
      if (!body.success) {
        return fail('invalid_request', 400)
      }
      // Idempotency-Key (one per Create press): a re-sent create with the same key and body answers
      // with the sandbox the first one made, for 24 h, instead of starting another (PC-8).
      let timings: Ready['timings']
      try {
        // EP-5: a create outlives its request (ctx.waitUntil), like a wake. A desktop that cancels mid-create
        // disconnects; the create still finishes (or fails and frees its VM) and stores its answer, so the
        // cancel's replay gets the sandbox to delete instead of 409 `idempotency_in_progress` for minutes.
        const response = await outlivingRequest(
          life,
          withIdempotency(
          life.db,
          { accountId: caller.accountId, scope: `sandbox.create:${caller.userId}`, key: readIdempotencyKey(request), body: raw, now: life.now() },
          async () => {
            // Desktops that show the clone as its own step ask for it in the background (GET .../clone).
            // Member identities install after the response; the VM's git holds commits and pushes until then.
            const ready = await createSandbox(life, caller, {
              ...body.data,
              cloneInBackground: features.includes('clone-progress'),
              deferMemberGit: true
            })
            await recordOwnerDeviceForCreate(life, ready)
            await auditSession(life.db, caller, { action: 'workspace.create', targetType: 'workspace', targetId: ready.row.id, detail: { origin: 'desktop', visibility: ready.row.visibility } }, life.now())
            timings = ready.timings
            return { status: 200, body: readyView(ready.row, ready.connection, ready.cloning, features.includes('repo-update')) }
          }
          )
        )
        const timing = Object.entries(timings ?? {})
          .map(([phase, ms]) => `${phase};dur=${ms}`)
          .join(', ')
        if (timing) {
          response.headers.set('server-timing', timing)
        }
        return response
      } catch (error) {
        if (error instanceof ApiError) {
          return fail(error.code, error.status, error.reason)
        }
        throw error
      }
    }
    const row = await getSandbox(env.SANDBOX_DB, id)
    const route = `${request.method} ${action ?? ''}`
    const owner = row !== null && row.account_id === caller.accountId && row.user_id === caller.userId
    const adminAction =
      (route === 'DELETE ' || route === 'POST suspend') && row?.account_id === caller.accountId && isOrgAdmin(caller)
    // The creator can always see and delete their own sandbox, whichever team is active now: a team
    // switch must never leave a billed VM that its owner's Delete can't reach. Nothing that bills
    // (resume, rollover) crosses accounts.
    // A creator removed from that team gets nothing cross-team: the sandbox is the team's now.
    const creatorStop =
      (route === 'GET ' || route === 'DELETE ') &&
      row !== null &&
      row.user_id === caller.userId &&
      !(await creatorLeftAccount(env.SANDBOX_DB, row.account_id, caller.userId))
    // Another account's (or a teammate's) sandbox is indistinguishable from a missing one.
    if (!row || !(owner || adminAction || creatorStop)) {
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
        // The name goes with the row's history: the workspace can no longer be looked up.
        await auditSession(life.db, caller, { action: 'workspace.destroy', targetType: 'workspace', targetId: row.id, detail: { name: row.name ?? null } }, life.now())
        return json({ sandbox: view(destroyed) })
      }
      case 'POST suspend': {
        // `{ reason: 'idle' }` is the desktop's idle timer; anything else (no body: phone,
        // older desktops) is someone choosing to sleep it, which predictive wake must respect.
        const body = (await readJson(request).catch(() => ({}))) as { reason?: unknown } | null
        const suspended = await suspendSandbox(life, row)
        if (body?.reason !== 'idle') {
          // A hint only: the sleep itself already happened, so a failed write never fails it.
          await markUserSlept(life.db, row.id, life.now()).catch((error: unknown) =>
            console.log(JSON.stringify({ event: 'user_slept_write_failed', error: String(error) }))
          )
        }
        return json({ sandbox: view(suspended) })
      }
      case 'POST resume': {
        const ready = await outlivingRequest(life, resumeSandbox(life, row))
        await recordOwnerDeviceAndSync(life, ready.row, ready.connection.pairingCode)
        return readyResponse(ready)
      }
      case 'POST rollover': {
        const ready = await outlivingRequest(life, rolloverSandbox(life, row))
        await recordOwnerDeviceAndSync(life, ready.row, ready.connection.pairingCode)
        return readyResponse(ready)
      }
      case 'POST wake':
        return json(await wakeSandbox(life, row, { waitMs: parseWakeWait(url, await readJson(request)), ...workspaceConfig(env, deps) }))
      case 'POST restart': {
        // User-triggered and unbounded otherwise: shares the per-account start rate limit.
        await consumeCreateToken(life.db, life.config.guardrails!, caller.accountId, life.now())
        const ready = await outlivingRequest(life, restartSandbox(life, row))
        await recordOwnerDeviceAndSync(life, ready.row, ready.connection.pairingCode)
        return json(readyView(ready.row, ready.connection))
      }
      case 'GET clone':
        // The background clone of a create made with feature `clone-progress` (clone-status.ts).
        return json({ clone: await readCloneStatus(life, row) })
      case 'GET status':
      {
        const [{ idleSleepMinutes, ...status }, hints] = await Promise.all([
          workspaceStatus(life, row, workspaceConfig(env, deps)),
          wakeHintsAware ? wakeHints(life.db, row, life.now()) : null
        ])
        return json({
          sandbox: view(row),
          status: { ...status, ...(idleMinutesAware ? { idleSleepMinutes } : {}), ...(hints ?? {}) }
        })
      }
      case 'POST archive': {
        const body = ArchiveRequestSchema.safeParse(await readJson(request, MAX_ARCHIVE_JSON_BYTES))
        if (!body.success) {
          return fail('invalid_request', 400)
        }
        const archived = await archiveSandbox(life, row, body.data, workspaceConfig(env, deps))
        await auditSession(life.db, caller, { action: 'workspace.archive', targetType: 'workspace', targetId: row.id }, life.now())
        return json({ sandbox: view(archived) })
      }
      case 'GET archive':
        return json({ archive: await readArchive(env.SANDBOX_DB, row.id) })
      case 'POST unarchive': {
        const ready = await unarchiveSandbox(life, row)
        await auditSession(life.db, caller, { action: 'workspace.unarchive', targetType: 'workspace', targetId: row.id }, life.now())
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

/** POST /v1/github/connect body (optional): preselect this repository and return to this setup session. */
const ConnectBodySchema = z
  .object({
    repo: z.string().max(400).optional(),
    setupSessionId: z.string().regex(SETUP_SESSION_ID).optional(),
    repoId: z.number().int().positive().optional(),
    ownerId: z.number().int().positive().optional()
  })
  .strip()

function repoAccessDeps(env: Env, deps: Deps): RepoAccessDeps {
  return {
    db: env.SANDBOX_DB,
    github: deps.github ?? githubMinter(env),
    connect: githubConnect(env, deps),
    publicRepoCheck: deps.publicRepoCheck ?? ((repoUrl) => githubRepoIsPublic(repoUrl)),
    fetch: deps.githubFetch ?? fetch,
    now: (deps.now ?? Date.now)(),
    githubUser: async (caller) => {
      const keyring = keyringFor(env)
      const identity = keyring
        ? await memberGitIdentity(env.SANDBOX_DB, await keyring, githubConnect(env, deps), caller.accountId, caller.userId, (deps.now ?? Date.now)())
        : null
      return identity ? { login: identity.login, token: identity.token } : null
    }
  }
}

function setupNotifier(env: Env, deps: Deps): SetupNotifier {
  if (deps.setupNotifier) {
    return deps.setupNotifier
  }
  return billingSetupNotifier({
    billingUrl: env.BILLING_URL,
    token: env.CONTROL_PLANE_TOKEN,
    fetch: env.BILLING ? (input, init) => env.BILLING!.fetch(input, init) : fetch
  })
}

function trialNotifier(env: Env, deps: Deps): TrialGitHubNotifier {
  return (
    deps.trialNotifier ??
    billingTrialNotifier({
      billingUrl: env.BILLING_URL,
      token: env.CONTROL_PLANE_TOKEN,
      fetch: env.BILLING ? (input, init) => env.BILLING!.fetch(input, init) : fetch
    })
  )
}

/** Where the browser goes after GitHub when a cloud setup session started the install (auth's setup pages). */
function cloudSetupNextUrl(origin: string, sessionId: string): string | null {
  try {
    const next = new URL('/cloud/setup/next', origin)
    if (next.protocol !== 'https:' && next.hostname !== 'localhost') {
      return null
    }
    next.searchParams.set('session', sessionId)
    next.searchParams.set('from', 'github')
    return next.toString()
  } catch {
    return null
  }
}

/** GET /v1/internal/github/install-url: billing's setup chain asks where its GitHub step should go. */
async function internalInstallUrl(env: Env, deps: Deps, url: URL): Promise<Response> {
  const accountId = url.searchParams.get('accountId') ?? ''
  const userId = url.searchParams.get('userId') ?? ''
  const repo = url.searchParams.get('repo') ?? ''
  const session = url.searchParams.get('session') ?? undefined
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(accountId) || !/^[A-Za-z0-9_.:@|-]{1,160}$/.test(userId) || !parseGitHubRepo(repo)) {
    return fail('invalid_request', 400)
  }
  if (session !== undefined && !SETUP_SESSION_ID.test(session)) {
    return fail('invalid_request', 400, 'session')
  }
  const access = repoAccessDeps(env, deps)
  try {
    const result = await repoAccess(access, accountId, repo)
    if (result.access !== 'missing') {
      return json({ access: result.access, url: null })
    }
    if (!access.connect) {
      return fail('not_configured', 503)
    }
    // N5: a GitHub identity auth verified from the user's GitHub sign-in (billing passes it on).
    const githubUserId = Number(url.searchParams.get('githubUserId') ?? NaN)
    const githubLogin = url.searchParams.get('githubLogin') ?? ''
    const githubUser =
      Number.isSafeInteger(githubUserId) && githubUserId > 0 && /^[A-Za-z0-9-]{1,39}$/.test(githubLogin)
        ? { id: githubUserId, login: githubLogin }
        : undefined
    const install = await repoInstallUrl(access, { accountId, userId }, repo, {
      setupSessionId: session,
      ...(githubUser ? { githubUser } : {})
    })
    return json({ access: result.access, url: install.url })
  } catch (error) {
    console.log(JSON.stringify({ event: 'github_install_url_failed', error: String(error).slice(0, 160) }))
    return fail('provider_unavailable', 502, 'github_unavailable')
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
    userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
    /** Auth's time of the removal (ms); tokens issued up to then stop working. */
    changedAt: z.number().int().positive().optional(),
    /** Who removed them (the same id when they left by themselves); absent from a directory sync. */
    actorUserId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional()
  })
  .strict()

async function workspaceRoute(request: Request, url: URL, env: Env, deps: Deps, caller: SandboxCaller): Promise<Response> {
  const db = env.SANDBOX_DB
  const clock = deps.now ?? Date.now
  const now = clock()
  // Labels for teammates' lists; a failure here must never fail the request itself.
  await rememberCallerName(db, caller, now).catch((error: unknown) => console.warn('member_name_write_failed', String(error)))
  if (url.pathname === '/v1/team/links/resolve' && request.method === 'GET') {
    try {
      return json(await resolveLink(db, caller, url, now))
    } catch (error) {
      if (error instanceof LinkOtherOrgError) {
        return json({ error: 'not_found', reason: 'other_org', orgId: error.orgId }, 404)
      }
      throw error
    }
  }
  if (url.pathname === '/v1/team/prefs') {
    if (request.method === 'GET') {
      return json(await getWorkspacePrefs(db, caller))
    }
    if (request.method === 'PUT') {
      return json(await putWorkspacePrefs(db, caller, await readJson(request), now))
    }
    return fail('not_found', 404)
  }
  if (url.pathname === '/v1/team/org') {
    if (request.method === 'GET') {
      return json(await getOrgSlug(db, caller, url, now))
    }
    if (request.method === 'PUT') {
      return json(await putOrgSlug(db, caller, await readJson(request), now))
    }
    return fail('not_found', 404)
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
  if (url.pathname.startsWith('/v1/team/members/') || url.pathname.startsWith('/v1/team/pokes')) {
    try {
      const answer = await teamPresenceRoute(db, caller, request, url, now, () => readJson(request), {
        activitySharing: env.TEAMMATE_ACTIVITY_SHARING === 'team' ? 'team' : 'opt_in'
      })
      return answer === null ? fail('not_found', 404) : json(answer)
    } catch (error) {
      if (error instanceof TeamPresenceError) {
        const response = json(
          { error: error.code, ...(error.reason ? { reason: error.reason } : {}), ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) },
          error.status
        )
        if (error.retryAfterMs) {
          response.headers.set('retry-after', String(Math.ceil(error.retryAfterMs / 1000)))
        }
        return response
      }
      throw error
    }
  }
  const match = /^\/v1\/team\/workspaces\/(sbx_[0-9a-f]{24})(?:\/(presence|follow|wake|lease|grants|sent|read-snapshot)(?:\/(grt_[0-9a-f]{24}))?)?$/.exec(url.pathname)
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
  if (route === 'GET read-snapshot') {
    try {
      return json(await getReadSnapshot(db, caller, row, url.searchParams.get('keyId'), now))
    } catch (error) {
      if (error instanceof ReadSnapshotRouteError) {
        return fail(error.code, error.status)
      }
      throw error
    }
  }
  if (route === 'POST sent') {
    // The caller's own client: "I just sent a message here" (opens their git-as-sender window).
    if (!canOpen(caller, row)) {
      throw new WorkspaceError('not_found')
    }
    await recordMemberSend(db, row.id, caller.userId, now)
    return json({ ok: true })
  }
  if (route === 'PUT follow' || route === 'DELETE follow') {
    // Following needs seeing it; an admin addressing a private row for management can't follow it.
    if (!canSee(caller, row)) {
      throw new WorkspaceError('not_found')
    }
    return json(await setFollow(db, caller, row, route === 'PUT follow', now))
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
      const { archived, ...rest } = body.data
      // Archive/unarchive are lifecycle changes, not labels. The lifecycle runs FIRST and is what
      // sets archived_at, so a failed or refused archive never labels a running sandbox archived.
      let archivedNow = false
      if (archived !== undefined) {
        assertCanManageWorkspace(caller, row)
        if (archived && row.archived_at === null) {
          if (row.status !== 'running' && row.status !== 'suspended') {
            // Starting, waking or going to sleep: nothing changes; the client asks to try again.
            return fail('conflict', 409, `sandbox_${row.status}`)
          }
          await archiveSandbox(life, row, {}, workspaceConfig(env, deps))
          archivedNow = true
        } else if (!archived && row.status === 'archived') {
          await restoreArchivedToSleeping(life, row)
        } else if (!archived && row.archived_at !== null) {
          // A label-only archive from before archive stopped the sandbox: clear the label.
          await patchWorkspace(db, caller, row, { archived: false }, now)
        }
      }
      const current = (await getSandbox(env.SANDBOX_DB, row.id)) ?? row
      let patched: Awaited<ReturnType<typeof patchWorkspace>> =
        Object.keys(rest).length > 0
          ? await patchWorkspace(db, caller, current, rest, now)
          : { row: current, revoke: 'none' }
      // Who can open a workspace decides who its agents act as and whose secrets it gets, so both
      // directions of a share, and a change of owner, go in the team's audit log.
      if (patched.row.visibility !== current.visibility) {
        await auditSession(
          db,
          caller,
          {
            action: patched.row.visibility === 'team' ? 'workspace.shared_with_team' : 'workspace.made_private',
            targetType: 'workspace',
            targetId: row.id,
            detail: { from: current.visibility, to: patched.row.visibility }
          },
          now
        )
      }
      if (patched.row.user_id !== current.user_id) {
        await auditSession(
          db,
          caller,
          { action: 'workspace.owner_changed', targetType: 'workspace', targetId: row.id, detail: { fromUserId: current.user_id, toUserId: patched.row.user_id } },
          now
        )
      }
      if (archivedNow && patched.revoke === 'none') {
        // Archiving disconnects teammates' devices, as before.
        patched = { ...patched, revoke: 'non_owner' }
      }
      if (patched.revoke !== 'none') {
        // Readers lose the sleeping copy at once, before (and regardless of) the VM-side revokes.
        await pruneReadSnapshotToOwner(db, patched.row)
      }
      const revoked =
        patched.revoke === 'none' ? null : await revokeForAccessChange(life, patched.row, patched.revoke, caller.userId)
      if (
        patched.row.status === 'running' &&
        (patched.row.user_id !== current.user_id || patched.row.visibility !== current.visibility)
      ) {
        // A new owner or a share changes which account (if any) the agents use (D10/D13): rebuild the env now.
        const work = refreshSandboxEnv(life, patched.row).catch(() => false)
        if (deps.waitUntil) {
          deps.waitUntil(work)
        } else {
          await work
        }
      }
      return json({ workspace: await view(patched.row), ...(revoked ? { revoked } : {}) })
    }
    case 'POST wake': {
      if (!canOpen(caller, row)) {
        throw new WorkspaceError('not_found')
      }
      if (url.searchParams.has('wait')) {
        // The same single-flight long-poll wake as the owner's POST /v1/sandboxes/:id/wake (phones),
        // billed and capped exactly like it. The endpoint stays out: a teammate gets in only through
        // their own grant, never by learning where the VM listens.
        const answer = await wakeSandbox(life, row, { waitMs: parseWakeWait(url, null), ...workspaceConfig(env, deps) })
        return json({ ...answer, endpoint: null })
      }
      // Never returns the owner's pairing offer; teammates get in through their own grant.
      const ready = await outlivingRequest(life, resumeSandbox(life, row))
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

/**
 * Binding the App through OAuth proves who the binder is on GitHub, and GitHub already handed us
 * their user token: keep it as their commit identity (git-as-sender), as if they had connected it
 * separately. Best effort: the bind stands even when this is skipped or fails. Never logs tokens.
 */
async function storeIdentityOnBind(env: Env, state: { a: string; u: string }, identity: OAuthIdentity, now: number): Promise<void> {
  const keyring = keyringFor(env)
  if (!keyring) {
    console.log(JSON.stringify({ event: 'github_user_stored_on_bind', stored: 0, skipped: 'no_keyring' }))
    return
  }
  try {
    await storeUserToken(env.SANDBOX_DB, await keyring, { account_id: state.a, user_id: state.u }, identity.user, identity.tokens, now)
    console.log(JSON.stringify({ event: 'github_user_stored_on_bind', stored: 1 }))
  } catch (error) {
    console.log(JSON.stringify({ event: 'github_user_stored_on_bind', stored: 0, failed: error instanceof Error ? error.name : 'unknown' }))
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
    if (result.identity) {
      await storeIdentityOnBind(env, result.state, result.identity, (deps.now ?? Date.now)())
    }
    const esc = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, '')
    const requested = 'requested' in result
    if ('boundIds' in result) {
      const notify = trialNotifier(env, deps)
      for (const ids of result.boundIds) {
        await notify({ accountId: result.state.a, ...ids })
      }
    }
    // Tell a waiting setup session (the desktop polls it and starts on its own), then go back to it.
    const notice = await noticeAfterReturn(repoAccessDeps(env, deps), result.state, requested).catch(() => null)
    if (notice) {
      await setupNotifier(env, deps)(notice)
    }
    const next = result.state.s && env.CLOUD_SETUP_ORIGIN ? cloudSetupNextUrl(env.CLOUD_SETUP_ORIGIN, result.state.s) : null
    if (next) {
      return new Response(null, { status: 302, headers: { location: next, 'cache-control': 'no-store' } })
    }
    if ('requested' in result) {
      return html(
        `GitHub sent your request to an owner of <b>${esc(result.requested.owner)}</b>. Orca Cloud gets access once they approve it, and a waiting workspace starts then if Orca is open. You can close this tab.`
      )
    }
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

/** The KMS-held secret keys cannot be fetched right now (SECRETS_KEK_SOURCE=kms). Retryable. */
function secretsUnavailableResponse(): Response {
  const response = fail('secrets_unavailable', 503)
  response.headers.set('retry-after', '30')
  return response
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
  if (error instanceof OrgMismatchError) {
    return orgMismatchResponse()
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
  if (error instanceof PlatformHostSuffixesConfigError) {
    return platformHostsMisconfigured(error)
  }
  if (error instanceof SecretsKmsError) {
    return secretsUnavailableResponse()
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
    const fifthMinute = new Date(controller.scheduledTime).getUTCMinutes() % 5 === 0
    if (env.AGENT_ACCOUNTS_CODEX === 'on') {
      ctx.waitUntil(codexTick(env, fifthMinute))
    }
    if (!fifthMinute) {
      return
    }
    ctx.waitUntil(
      lifecycleDeps(env, {}).then(async (life) => {
        if (life) {
          // Counts only; no ids, tokens or pairing material.
          const summary = await reconcile(life)
          console.log(JSON.stringify({ event: 'reconcile', ...summary }))
          // Internal fair-use review (U22): retry sessions whose CPU the stop couldn't read yet.
          const cpu = await sweepSessionCpu(life.db, life.provider, life.now())
          if (cpu.checked > 0) {
            console.log(JSON.stringify({ event: 'session_cpu_sweep', ...cpu }))
          }
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
          const refresh = await refreshEnvironmentsOnGolden(env, fresh)
          if (refresh.stale > 0) {
            console.log(JSON.stringify({ event: 'environment_golden_refresh', ...refresh }))
          }
          // Automatic environments unused for 14 days go with their snapshots (storage).
          const expired = await expireAutoEnvironments(buildDeps(fresh, {}, env)).catch(() => 0)
          if (expired > 0) {
            console.log(JSON.stringify({ event: 'auto_environments_expired', expired }))
          }
        }
      })
    )
  }
} satisfies ExportedHandler<Env>

/**
 * Codex (flag S2): every minute, broker logins move on; every fifth, the lease refresher renews due tokens
 * (kept fresh while the kill switch is on, so turning it off again just works) and leaked brokers go.
 */
export async function codexTick(env: Env, fifthMinute: boolean, deps: Deps = {}): Promise<void> {
  const broker = await codexBrokerDeps(env, deps)
  if (!broker) {
    return
  }
  const brokers = await codexBrokerTick(broker, { sweepProvider: fifthMinute }).catch((error: unknown) => ({ error: String(error).slice(0, 200) }))
  if (!('advanced' in brokers) || brokers.advanced > 0 || brokers.leaked > 0) {
    console.log(JSON.stringify({ event: 'codex_broker_tick', ...brokers }))
  }
  if (fifthMinute) {
    const refresh = await refreshCodexLeases({
      db: env.SANDBOX_DB,
      keyring: broker.keyring,
      now: deps.now ?? Date.now,
      fetch: deps.codexTokenFetch,
      onChanged: broker.onStored
    }).catch((error: unknown) => ({ error: String(error).slice(0, 200) }))
    if (!('due' in refresh) || refresh.due > 0) {
      console.log(JSON.stringify({ event: 'codex_refresh', ...refresh }))
    }
  }
}

/** Org environments built on an older golden rebuild on the current one (environment-golden-refresh.ts). */
export async function refreshEnvironmentsOnGolden(env: Env, life: LifecycleDeps, deps: Deps = {}) {
  return refreshStaleEnvironments(buildDeps(life, deps, env)).catch((error: unknown) => {
    console.log(JSON.stringify({ event: 'environment_golden_refresh_failed', error: String(error).slice(0, 200) }))
    return { stale: 0, started: 0, skipped: 0 }
  })
}

/**
 * RPC entrypoint for the build runner Worker (src/build-runner.ts), bound there as its CONTROL service.
 * Each runner alarm lands here: the step runs in this Worker, with its D1, provider and secrets, and
 * answers the delay until the next step (null: final, the runner stops). A failure throws back to the
 * runner, which retries. Not reachable from the internet: only a service binding can name an entrypoint.
 */
export class BuildTicker extends WorkerEntrypoint<Env> {
  tickBuild(build: RunnerBuild): Promise<number | null> {
    return runBuildTick(this.env, build)
  }
}

/** One runner step; null when the control plane is unconfigured (the cron re-arms the runner later). */
export async function runBuildTick(env: Env, build: RunnerBuild, deps: Deps = {}): Promise<number | null> {
  const life = await lifecycleDeps(env, deps)
  if (!life) {
    return null
  }
  try {
    return await tickBuild(buildDeps(life, deps, env), build.environmentId, build.id)
  } catch (error) {
    console.log(JSON.stringify({ event: 'environment_build_tick_failed', buildId: build.id, error: String(error).slice(0, 200) }))
    throw error
  }
}

async function agentSourcesRoute(request: Request, url: URL, env: Env, deps: Deps, caller: SandboxCaller): Promise<Response> {
  const db = env.SANDBOX_DB
  const now = (deps.now ?? Date.now)()
  // Labels for the owner block on teammates' views; a failure here must never fail the request.
  await rememberCallerName(db, caller, now).catch(() => undefined)
  const noStore = (body: unknown) => Response.json(body, { headers: { 'cache-control': 'no-store' } })
  try {
    if (request.method === 'GET' && url.pathname === '/v1/agent-sources') {
      return noStore(await agentSourcesView(db, caller, url.searchParams.get('workspaceId'), providerEnabled(env), now))
    }
    if (request.method === 'PUT' && url.pathname === '/v1/agent-sources/offer') {
      const body = PutOfferSchema.safeParse(await readJson(request))
      if (!body.success) {
        return fail('invalid_request', 400)
      }
      await putOfferAnswer(db, caller, body.data, now)
      return noStore(await agentSourcesView(db, caller, null, providerEnabled(env), now))
    }
    if (request.method === 'PUT' && url.pathname === '/v1/agent-sources') {
      const body = PutSourceSchema.safeParse(await readJson(request))
      if (!body.success) {
        return fail('invalid_request', 400)
      }
      const row = await putAgentSource(db, caller, body.data, now)
      // A running sandbox picks the change up in new shells within seconds (same path as a secret edit).
      const targets = row ? (row.status === 'running' ? [row] : []) : await runningSandboxesForDefault(db, caller.userId, body.data.agent)
      if (targets.length > 0) {
        const work = lifecycleDeps(env, deps).then(async (life) => {
          if (life) {
            for (const target of targets) {
              await refreshSandboxEnv(life, target).catch(() => false)
            }
          }
        })
        if (deps.waitUntil) {
          deps.waitUntil(work.catch(() => undefined))
        } else {
          await work
        }
      }
      return noStore(await agentSourcesView(db, caller, body.data.workspaceId ?? null, providerEnabled(env), now))
    }
    return fail('not_found', 404)
  } catch (error) {
    if (error instanceof AgentSourceError) {
      return fail(error.code, error.status, error.reason)
    }
    throw error
  }
}
