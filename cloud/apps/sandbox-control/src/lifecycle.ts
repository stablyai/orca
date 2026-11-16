// Sandbox lifecycle: one persistent provider sandbox per Orca workspace, with an Orca-owned lease,
// a forced stop before the provider's 24h cap, usage metering and write-ahead rows.
import { accountProvider } from './account-providers'
import { readUsableAgentCredential } from './agent-credentials'
import { CODEX_FIREWALL_ALL_PATHS, CODEX_FIREWALL_PATHS } from './codex-paths'
import { codexPlaceholder } from './codex-credentials'
/** Where Codex refreshes its ChatGPT login. */
export const CODEX_AUTH_HOST = 'auth.openai.com'
import { parseStoredCodex } from './codex-credentials'
import { isSharedWorkspace } from './shared-workspace'
import { deleteAgentSourcesForSandbox } from './agent-sources'
import { signOutAgentsBeforeDelete } from './agent-signout'
import type { EntitlementClient, MachineSize } from './entitlements'
import { parseGitHubRepo, type GitHubAppMinter } from './github-app'
import {
  DEFAULT_GUARDRAILS,
  GuardrailError,
  assertAccountCapacity,
  assertStartsOpen,
  killSwitchOn,
  type GuardrailConfig
} from './guardrails'
import { DEFAULT_EGRESS_ALLOWLIST, DEFAULT_EGRESS_PRESET, KEYS_WITHHELD_BODY, compileNetworkPolicy, egressProxyMissing, gitBasicAuthorization, type CredentialRoute, type EgressPreset, type PlatformHostSuffixesConfigError } from './network-policy'
import { applyQueuedRevokes } from './grant-revokes'
import { ENTRY_POINTS_PROBE, ensureEntryPoints, entryPointsBehind, installEntryPoints, parseEntryPointsProbe } from './golden-images'
import { RUNTIME_REFRESH_SCRIPT, type RuntimeBundle } from './runtime-bundles'
import { memberPlaceholder, type MemberGitIdentity } from './github-user-tokens'
import { connectedMembers, memberGitConfigs } from './member-git'
import type { RetentionConfig } from './retention'
import { ProviderError, type ProviderSandboxState, type SandboxProviderApi } from './sandbox-provider'
import { egressAccountRoutes, egressSecretHosts, placeholderValues, secretPlaceholder, type SecretEgressHost } from './secret-egress'
import { credentialTargets, firewallEligibleSecret } from './provider-env'
import { egressAllowHosts, resolvedProviderEnv, sessionSecretEnv, type SessionSecrets } from './session-env'
import type { Keyring } from './secrets-crypto'
import type { SecretsKmsReason } from './secrets-kms'
import { captureReadSnapshot, deleteReadSnapshot } from './read-snapshots'
import {
  ORCAD_PORT,
  SHARE_PROXY_PORT,
  VmCommandError,
  workspaceHostname,
  drainOrcad,
  runningOrcad,
  startOrcad,
  type OrcadReady,
  type StartInputs,
  START_TIMEOUT_MS
} from './sandbox-vm-commands'
import { WORKSPACE_PRELUDE_SCRIPT } from '../image/vm-scripts.generated'
import { resolveEnvironmentBoot, type BootSource } from './environments'
import { belowSecurityFloor } from './environment-security'
import { shareProxyKey } from './share-crypto'
import { claimPooledVm, deletePooledVm, maintainPool, type PoolConfig, type PooledVm } from './pool'
import {
  detachFromWorkspace,
  NO_SESSION,
  countActiveSandboxes,
  countActiveSandboxesForUser,
  getSandbox,
  insertSandbox,
  listAccountSandboxes,
  liveSandboxForWorkspace,
  markSnapshotsDeleted,
  recordSnapshots,
  recordedSnapshotIds,
  transition,
  type SandboxRow,
  type SessionFields
} from './store'
import { recordSessionEnd } from './session-cpu'
import { flushUsage, queueUsage } from './usage'
import { SANDBOX_VCPUS } from './machine-size'
import { isRegionalFailure } from './regions'
import { forgetWorkspaceFollows } from './workspace-follows'
import { learnArchiveHook, resetArchiveHookMemo } from './archive-hook'

export const LEASE_MS = 30 * 60_000
/**
 * RESUME-STUCK: a `resuming` row this old has no live wake behind it. An inline wake lives as long
 * as its request (the desktop's boot timeout is 180 s) plus ctx.waitUntil's 30 s past a disconnect;
 * same bar as the wake long-poll's WAKE_STALE_MS, so a healthy slow boot is never taken over.
 */
export const RESUME_STALE_MS = 4 * 60_000
/** How long a resume waits on a wake someone else started before answering 409. */
const RESUME_JOIN_MS = 30_000
const RESUME_POLL_MS = 500
const PROVIDER_SESSION_CAP_MS = 24 * 60 * 60_000
/** Orca stops 10 min early so it, not the provider, ends the session (drain first). */
export const SESSION_DEADLINE_MS = PROVIDER_SESSION_CAP_MS - 10 * 60_000
const DAY_MS = 24 * 60 * 60_000
/** Provider-side backstop: longer than idle retention (90d) + its warning, so Orca deletes first. */
export const DEFAULT_SNAPSHOT_EXPIRATION_MS = 104 * DAY_MS

export type LifecycleDeps = {
  db: D1Database
  provider: SandboxProviderApi
  entitlements: EntitlementClient
  /** GitHub App installation tokens for the workspace repo; absent until the app is configured. */
  github?: GitHubAppMinter
  /** Secret store; absent (no SECRETS_KEK) means sessions start without injected secrets. */
  /**
   * egressPlaceholders: every account (`true`) or only the listed account ids (staged rollout);
   * egressPlaceholdersOff: per-account kill switch that wins over both.
   */
  /** Set while the KMS-held keys cannot be fetched: a session start fails instead of running without its secrets. */
  secretsUnavailable?: SecretsKmsReason
  secrets?: {
    keyring: Keyring
    egressPlaceholders: boolean | ReadonlySet<string>
    egressPlaceholdersOff?: ReadonlySet<string>
    /** Flags S1/S2 minus the kill switch: which agents may use an Orca-account credential (D11). */
    accountProviders?: Record<'claude' | 'codex', boolean>
  }
  now: () => number
  /** Waits between polls of a wake already in flight (tests advance a fake clock). */
  sleep?: (ms: number) => Promise<void>
  /** A member's GitHub identity (user token) for git-as-sender; absent = app identity only. */
  memberIdentity?: (row: SandboxRow, userId: string) => Promise<MemberGitIdentity | null>
  /** Orphan/retention policy for the cron; defaults in retention.ts. */
  retention?: RetentionConfig
  /**
   * Whether a github.com repo clones anonymously (public). Asked only when no App token covers it, so a
   * private repo without a connected GitHub fails fast with `github_not_connected` instead of a clone
   * error after boot. Absent: no check.
   */
  publicRepoCheck?: (repoUrl: string) => Promise<boolean>
  /**
   * Automatic environments (auto-environments.ts): `ensure` after a create of a repo no environment
   * lists, `touch` when a create booted from an automatic one. Absent: neither happens.
   */
  autoEnvironment?: {
    /** `region`: where the create that asked runs; the environment builds there (a snapshot is region-bound). */
    ensure(accountId: string, repoUrl: string, region: string): Promise<unknown>
    touch(environmentId: string): Promise<unknown>
  }
  /**
   * ENV-BUILD-CHURN: a create booted from (or was kept off) this environment. Records the use and
   * rebuilds it on the current golden when stale and due, or below the security floor; at most one build.
   */
  environmentUsed?: (environmentId: string) => Promise<unknown>
  /** Work that may finish after the response (Worker ctx.waitUntil); absent means fire-and-forget. */
  background?: (work: Promise<unknown>) => void
  /**
   * ENV-STALE: the region's active golden runtime bundle and a signed download URL, for the boot step that
   * brings an older image's orcad current (runtime-bundles.ts). Absent = no refresh.
   */
  runtimeRefresh?: (region: string, now: number) => Promise<{ bundle: RuntimeBundle; url: string } | null>
  /** Best-effort side effects of a session starting or ending (workspace tokens, see api/settings.ts). */
  hooks?: {
    afterBoot?(row: SandboxRow, sessionId: string): Promise<unknown>
    afterStop?(row: SandboxRow): Promise<unknown>
  }
  config: {
    environment: string
    /** The default region's golden image. */
    goldenSnapshotId: string
    /** Every region's golden image (a snapshot only boots in its own region); absent = default region only. */
    goldenSnapshots?: Record<string, string>
    defaultRegion: string
    /** Tried in order when the default region's create fails on capacity (regions.ts); each has a golden image. */
    fallbackRegions?: readonly string[]
    egressProxyUrl?: string
    /** Staging rehearsals shorten the cap; production uses SESSION_DEADLINE_MS. */
    sessionDeadlineMs?: number
    guardrails?: GuardrailConfig
    snapshotExpirationMs?: number
    /** Warm pool (pool.ts); absent or size 0 means every create boots its own VM. */
    pool?: PoolConfig
    /** Base egress allowlist (egressAllowlistFor ORCA_PLATFORM_HOST_SUFFIXES); default DEFAULT_EGRESS_ALLOWLIST. */
    egressAllowlist?: readonly string[]
    /** A malformed ORCA_PLATFORM_HOST_SUFFIXES: whatever compiles a limited-mode policy refuses with it. */
    egressAllowlistError?: PlatformHostSuffixesConfigError
    /** Hosts allowed on top of the default egress allowlist (e.g. this control plane for the in-VM CLI). */
    extraEgressHosts?: readonly string[]
    /** PARITY-DOCKER: false (SANDBOX_DOCKER=off) makes the VM's `docker` refuse instead of installing or starting Docker. */
    dockerEnabled?: boolean
    /** Workspace sandbox egress (SANDBOX_EGRESS_PRESET); default DEFAULT_EGRESS_PRESET ("open"). */
    egressPreset?: EgressPreset
    /** CODEX-FIREWALL-SWAP: swap the Codex account token at the sandbox firewall for its hot calls (no Worker hop). */
    codexFirewallSwap?: boolean
    /** EGRESS_SWAP_MODE: the default swap mode for sandboxes without their own (design §3). Unset: proxy. */
    egressSwapMode?: EgressSwapMode
    /** GH_AS_MEMBER=on: gh in workspaces acts as the attested sender (member-git.ts pins what it may sign). */
    ghAsMember?: boolean
    /** EGRESS_FIREWALL_CLASSES: the classes firewall mode swaps (default all); a removed class goes back to the proxy. */
    egressFirewallClasses?: readonly FirewallClass[]
    /** SHARE_LINK_SECRET: each session's share-proxy key derives from it; unset = no share links. */
    shareLinkSecret?: string
  }
}

/** The golden image new sandboxes in `region` boot from; null when that region has none. */
export function goldenFor(deps: Pick<LifecycleDeps, 'config'>, region: string): string | null {
  if (region === deps.config.defaultRegion) {
    return deps.config.goldenSnapshotId
  }
  return deps.config.goldenSnapshots?.[region] ?? null
}

/** Every region's golden image: shared, never deleted with a sandbox. */
export function goldenSnapshotIds(config: { goldenSnapshotId: string; goldenSnapshots?: Record<string, string> }): string[] {
  return [config.goldenSnapshotId, ...Object.values(config.goldenSnapshots ?? {})]
}

/** A pooled VM whose boot failed this soon after the claim is retried once on a fresh VM. */
export const POOL_RETRY_WITHIN_MS = 30_000

export class LifecycleError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'entitlement_denied' | 'provider_unavailable',
    readonly reason?: string
  ) {
    super(reason ? `${code}:${reason}` : code)
    this.name = 'LifecycleError'
  }
}

export type Ready = {
  row: SandboxRow
  connection: OrcadReady
  timings?: Record<string, number>
  /**
   * The repo is still being cloned ('clone') or, after an environment boot, brought up to date
   * ('update') in the VM (create with cloneInBackground); GET /clone reports it.
   */
  cloning?: 'clone' | 'update'
  /** The VM was told member git setup is pending (CREATE-GIT-ASYNC): the caller must finish it. */
  gitSetupPending?: boolean
  /**
   * ENV-BUILD-CHURN (d): the repo's environment was not used because its build is below the security
   * floor; the workspace started from the current golden without the environment's setup.
   */
  environmentHeld?: { environmentId: string; reason: 'security_update' }
}

/** Phase durations for one lifecycle call (logged + Server-Timing); counts only, no ids or secrets. */
export function phaseTimer(now: () => number = Date.now) {
  const timings: Record<string, number> = {}
  const timer = {
    timings,
    /** The first phase that threw, and how long it ran: names a create's failure (createFailureReason). */
    failed: null as { phase: string; ms: number } | null,
    async time<T>(phase: string, work: () => Promise<T>): Promise<T> {
      const started = now()
      const limit = PHASE_LIMITS[phase]
      let watch: ReturnType<typeof setTimeout> | undefined
      try {
        if (limit === undefined) {
          return await work()
        }
        // A phase with nothing slow in it that still hasn't answered is stuck (a create sat 180 s
        // before its write-ahead insert with no provider call stalled). Name it in the log; fail it
        // unless abandoning the work could strand something (the pool claim holds a VM).
        return await Promise.race([
          work(),
          new Promise<never>((_, reject) => {
            watch = setTimeout(() => {
              console.log(JSON.stringify({ event: 'phase_timeout', phase, ms: limit.ms, failed: limit.fail }))
              if (limit.fail) {
                reject(new LifecycleError('provider_unavailable', `phase_timeout_${phase}`))
              }
            }, limit.ms)
          })
        ])
      } catch (error) {
        timer.failed ??= { phase, ms: now() - started }
        throw error
      } finally {
        clearTimeout(watch)
        timings[phase] = now() - started
      }
    }
  }
  return timer
}

/**
 * Bounds for the phases before a create's write-ahead insert (D1 reads, billing, the pool claim).
 * The VM, policy and orcad phases are bounded by the provider calls inside them.
 */
export const PHASE_DEADLINES_MS = {
  environment: { ms: 20_000, fail: true },
  entitlement: { ms: 20_000, fail: true },
  pool: { ms: 45_000, fail: false }
}
const PHASE_LIMITS: Partial<Record<string, { ms: number; fail: boolean }>> = PHASE_DEADLINES_MS

/**
 * CREATE-BUILD-SNAPSHOT-404: a VM create from an environment build's snapshot can answer 404 just
 * after the build (dev, 11-11 and 11-13: the same snapshot booted seconds before and after). Once,
 * after a short wait, for a build under this age; never for goldens, old builds or other errors.
 */
const FRESH_BUILD_SNAPSHOT_MS = 15 * 60_000
const FRESH_BUILD_RETRY_WAIT_MS = 5_000

function freshBuildSnapshot404(error: unknown, source: BootSource | null, now: number): source is BootSource {
  return (
    error instanceof ProviderError &&
    error.status === 404 &&
    !!source &&
    typeof source.builtAt === 'number' &&
    now - source.builtAt < FRESH_BUILD_SNAPSHOT_MS
  )
}

type BootPrep = {
  secrets: SessionSecrets
  minted: { token: string; expiresAt: number } | null
  /** Members whose own GitHub identity this session may use (git as the sender). */
  memberPlaceholders: string[]
  /** What the firewall swaps itself (null: proxy mode). */
  firewall: FirewallInputs | null
}

/** Everything a boot needs that does not depend on the VM: resolved concurrently with the VM work. */
async function prepareBoot(deps: LifecycleDeps, row: SandboxRow): Promise<BootPrep> {
  const [secrets, minted, memberPlaceholders] = await Promise.all([
    sessionSecretEnv(deps, row),
    deps.github && row.repo_url ? deps.github.tokenForRepo(row.repo_url, row.account_id) : Promise.resolve(null),
    memberPlaceholdersFor(deps, row)
  ])
  // The account routes come from the secrets just resolved (egress_secret_hosts), so this runs after them.
  const firewall = await firewallInputsFor(deps, routedRow(row, { secrets } as BootPrep))
  return { secrets, minted, memberPlaceholders, firewall }
}

function routedRow(row: SandboxRow, prep: BootPrep): SandboxRow {
  return { ...row, egress_secret_hosts: prep.secrets.egressSecretHosts, egress_allow_hosts: prep.secrets.egressAllowHosts }
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `sbx_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

export function githubPlaceholderToken(row: SandboxRow): string {
  return `orca-ph-${row.id}`
}

/** Authorization values the VM's GitHub clients send (Octokit/fetch use Bearer, gh uses token). */
export function githubPlaceholderHeaders(row: SandboxRow): string[] {
  const token = githubPlaceholderToken(row)
  return [`Bearer ${token}`, `token ${token}`]
}

/**
 * The preset a policy write actually uses. Open egress needs EGRESS_PROXY_URL outside local/test: without it the
 * git installation token would sit in a Vercel transform rule under "*" (E3 review F1), so a deployed env missing
 * the proxy URL falls back to limited, loudly, on every policy write.
 */
export function effectiveEgressPreset(deps: Pick<LifecycleDeps, 'config'>, row: Pick<SandboxRow, 'id'>): EgressPreset {
  const preset = deps.config.egressPreset ?? DEFAULT_EGRESS_PRESET
  if (preset === 'open' && egressProxyMissing(deps.config)) {
    console.error(JSON.stringify({ event: 'egress_open_without_proxy', sandboxId: row.id, environment: deps.config.environment, applied: 'limited' }))
    return 'limited'
  }
  return preset
}

/** Refuses up front (503 platform_hosts_misconfigured) when this create or boot would compile a limited policy. */
export function assertEgressAllowlistUsable(deps: Pick<LifecycleDeps, 'config'>, row: Pick<SandboxRow, 'id'>): void {
  if (deps.config.egressAllowlistError && effectiveEgressPreset(deps, row) === 'limited') {
    throw deps.config.egressAllowlistError
  }
}

export type EgressSwapMode = 'proxy' | 'firewall'

export function parseEgressSwapMode(value: string | null | undefined): EgressSwapMode | undefined {
  return value === 'proxy' || value === 'firewall' ? value : undefined
}

/** The swap mode this sandbox runs in: its own override (sandboxes.egress_swap_mode), else the environment's. */
export function egressSwapModeFor(deps: Pick<LifecycleDeps, 'config'>, row: Pick<SandboxRow, 'egress_swap_mode'>): EgressSwapMode {
  return parseEgressSwapMode(row.egress_swap_mode) ?? deps.config.egressSwapMode ?? 'proxy'
}

/** Credential classes the firewall may swap (design §1); EGRESS_FIREWALL_CLASSES narrows them. */
export const FIREWALL_CLASSES = ['model_key', 'claude', 'codex', 'github_app'] as const
export type FirewallClass = (typeof FIREWALL_CLASSES)[number]

/** An Orca-account token for the firewall: `authorization` null means the account doesn't apply (signed out). */
export type FirewallAccount = { agent: 'claude' | 'codex'; host: string; authorization: string | null; accountId: string | null }

/**
 * What the firewall swaps itself for this sandbox (design §1). Null: proxy mode, the egress proxy swaps
 * everything. Resolved at compile time from current state; nothing here is logged or stored.
 */
export type FirewallInputs = {
  classes: ReadonlySet<FirewallClass>
  /** Firewall mode proper (not #776's Codex-only alias): nothing that can be swapped here goes to the proxy. */
  full: boolean
  accounts: readonly FirewallAccount[]
  /** Model keys by secret name; null: not usable now (deleted, moved away, unreadable). */
  secrets: ReadonlyMap<string, string | null>
}

export function parseFirewallClasses(value: string): FirewallClass[] {
  const known = new Set<string>(FIREWALL_CLASSES)
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name): name is FirewallClass => known.has(name))
}

export function firewallClasses(deps: Pick<LifecycleDeps, 'config'>, row: Pick<SandboxRow, 'egress_swap_mode'>): ReadonlySet<FirewallClass> {
  const out = new Set<FirewallClass>()
  if (egressSwapModeFor(deps, row) === 'firewall') {
    for (const name of deps.config.egressFirewallClasses ?? FIREWALL_CLASSES) {
      out.add(name)
    }
  } else if (deps.config.codexFirewallSwap) {
    // CODEX-FIREWALL-SWAP (#776): Codex's hot calls only, in proxy mode.
    out.add('codex')
  }
  return out
}

/**
 * CODEX-FIREWALL-SWAP / EGRESS firewall mode: the values the firewall needs. Same eligibility as the egress
 * proxy's per-request checks (index.ts): the owner's own account, never on a shared workspace, only while
 * the provider is on and the token is usable; a key only while it is still meant for that host.
 */
export async function firewallInputsFor(deps: LifecycleDeps, row: SandboxRow): Promise<FirewallInputs | null> {
  const classes = firewallClasses(deps, row)
  if (classes.size === 0 || !deps.config.egressProxyUrl || !deps.secrets) {
    return null
  }
  const keyring = deps.secrets.keyring
  const accounts: FirewallAccount[] = []
  for (const route of egressAccountRoutes(row)) {
    if (!classes.has(route.agent)) {
      continue
    }
    const applies = route.owner === row.user_id && !isSharedWorkspace(row) && Boolean(deps.secrets.accountProviders?.[route.agent])
    const stored = applies ? await readUsableAgentCredential(deps.db, keyring, row.user_id, route.agent, deps.now()).catch(() => null) : null
    if (route.agent === 'codex') {
      const tokens = stored ? parseStoredCodex(stored) : null
      accounts.push({ agent: 'codex', host: route.host, authorization: tokens ? `Bearer ${tokens.access_token}` : null, accountId: tokens?.account_id ?? null })
    } else {
      const provider = accountProvider('claude')
      accounts.push({ agent: 'claude', host: route.host, authorization: stored && provider ? provider.format(stored) : null, accountId: null })
    }
  }
  const secrets = new Map<string, string | null>()
  const entries = classes.has('model_key') ? egressSecretHosts(row).filter(firewallEligibleKey) : []
  if (entries.length > 0) {
    const current = await resolvedProviderEnv(deps.db, keyring, row).catch(() => null)
    const targets = current ? credentialTargets(current.env, current.scopes) : []
    for (const entry of entries) {
      const stillHere = targets.some((target) => target.secret === entry.secret && target.host === entry.host)
      secrets.set(entry.secret, stillHere ? (current?.env[entry.secret] ?? null) : null)
    }
  }
  return { classes, full: egressSwapModeFor(deps, row) === 'firewall', accounts, secrets }
}

/**
 * Keys the firewall can swap: no response filtering (Cursor's exchange, W1) and no path scope (Copilot's
 * PAT on api.github.com, W2: a prefix can't be pinned at the firewall). Those stay on the egress proxy.
 */
export function firewallEligibleKey(entry: SecretEgressHost): boolean {
  return firewallEligibleSecret(entry.secret) && !entry.keepResponseFields && !entry.paths
}

/** What Codex's own refresh of its placeholder login gets back: the same placeholder (CODEX-PLACEHOLDER-REFRESH). */
export function codexPlaceholderRefreshBody(row: Pick<SandboxRow, 'id'>): string {
  const placeholder = codexPlaceholder(row)
  return JSON.stringify({ access_token: placeholder, id_token: placeholder, refresh_token: '', token_type: 'Bearer', expires_in: 315_360_000 })
}

export function egressPolicy(
  deps: LifecycleDeps,
  row: SandboxRow,
  gitToken?: string,
  memberPlaceholders: readonly string[] = [],
  firewall: FirewallInputs | null = null
) {
  const proxyUrl = deps.config.egressProxyUrl
  const gitPlaceholder = gitBasicAuthorization(githubPlaceholderToken(row))
  // The workspace repo's installation token. With the egress proxy (every deployed env) it is forwarded and
  // swapped there, so the real token never sits in Vercel's policy store; the inline transform is the
  // no-proxy fallback only (git/libcurl is unaffected by the transform framing hang).
  // Firewall mode (design §1): the token sits in the policy itself, swapped by the firewall.
  const appOnFirewall = Boolean(firewall?.classes.has('github_app'))
  const git: CredentialRoute[] = !gitToken
    ? []
    : proxyUrl && !appOnFirewall
      ? [{ host: 'github.com', header: 'authorization', placeholders: [gitPlaceholder], via: 'forward', forwardURL: proxyUrl }]
      : [{ host: 'github.com', header: 'authorization', placeholders: [gitPlaceholder], via: 'transform', value: gitBasicAuthorization(gitToken) }]
  const credentials: CredentialRoute[] = proxyUrl
    ? [
        // Members' own GitHub identities: forwarded so the proxy can pin them to the workspace repo.
        ...(memberPlaceholders.length > 0
          ? [
              {
                host: 'github.com',
                header: 'authorization',
                placeholders: memberPlaceholders.map((p) => gitBasicAuthorization(p)),
                via: 'forward' as const,
                forwardURL: proxyUrl,
                // GH-ANON-403: with no App token, plain git sends no credential (a public repo's
                // clone, fetch, ls-remote). These member rules alone must not 403 it. With a token,
                // the workspace git route above keeps github.com fail-closed as before.
                ...(gitToken ? {} : { allowUnclaimed: true })
              },
              {
                host: 'api.github.com',
                header: 'authorization',
                placeholders: memberPlaceholders.flatMap((p) => [`Bearer ${p}`, `token ${p}`]),
                via: 'forward' as const,
                forwardURL: proxyUrl
              }
            ]
          : []),
        ...(appOnFirewall && gitToken
          ? githubPlaceholderHeaders(row).map(
              (placeholder): CredentialRoute => ({
                host: 'api.github.com',
                header: 'authorization',
                placeholders: [placeholder],
                via: 'transform',
                // `Bearer <placeholder>` / `token <placeholder>`: the same scheme with the real token.
                value: `${placeholder.slice(0, placeholder.indexOf(' '))} ${gitToken}`
              })
            )
          : [
              {
                host: 'api.github.com',
                header: 'authorization',
                placeholders: githubPlaceholderHeaders(row),
                via: 'forward' as const,
                forwardURL: proxyUrl
              }
            ]),
        // Model API keys swapped at egress (phase 2); each host also ends in the 403 deny rule, except a
        // host whose client sends its own short-lived token on later calls (Cursor).
        // An agent's Orca-account placeholder (D10): forwarded, claimed only by that exact Bearer value.
        ...egressAccountRoutes(row).flatMap(({ agent, host }): CredentialRoute[] => {
          const provider = accountProvider(agent)
          if (!provider) {
            return []
          }
          const placeholders = [provider.format(provider.placeholder(row))]
          const forward: CredentialRoute = { host, header: provider.header, placeholders, via: 'forward', forwardURL: proxyUrl }
          const swap = firewall?.accounts.find((entry) => entry.agent === agent && entry.host === host)
          if (!swap) {
            return [forward]
          }
          if (!swap.authorization) {
            // Fail closed (design §4.2): signed out, revoked, expired or not this owner's: the provider-shaped
            // answer from the firewall itself, so the agent says what to do.
            return provider.signedOut
              ? [{ host, header: provider.header, placeholders, via: 'respond', statusCode: provider.signedOut.status, body: provider.signedOut.body }]
              : [{ host, header: provider.header, placeholders, via: 'respond', statusCode: 403, body: KEYS_WITHHELD_BODY }]
          }
          if (agent === 'claude') {
            return [{ host, header: provider.header, placeholders, via: 'transform', value: swap.authorization }]
          }
          // CODEX-FIREWALL-SWAP: exact paths only, swapped right here. Firewall mode swaps every Codex call this way
          // and 403s the rest (no Worker, no relay); the #776 alias keeps the other calls on the proxy.
          const codexSwap: CredentialRoute = {
            host,
            header: provider.header,
            placeholders,
            paths: firewall?.full ? CODEX_FIREWALL_ALL_PATHS : CODEX_FIREWALL_PATHS,
            via: 'transform',
            value: swap.authorization,
            ...(swap.accountId ? { extraHeaders: { 'chatgpt-account-id': swap.accountId } } : {})
          }
          return firewall?.full ? [codexSwap] : [codexSwap, forward]
        }),
        ...egressSecretHosts(row).flatMap((entry) =>
          Object.keys(entry.headers).flatMap((header): CredentialRoute[] => {
            const placeholders = placeholderValues(entry, header, secretPlaceholder(row, entry.secret))
            const open = entry.allowUnclaimed ? { allowUnclaimed: true } : {}
            if (!firewall || !firewall.secrets.has(entry.secret)) {
              return [{ host: entry.host, header, placeholders, via: 'forward', forwardURL: proxyUrl, ...open }]
            }
            const value = firewall.secrets.get(entry.secret)
            if (!value) {
              return [{ host: entry.host, header, placeholders, via: 'respond', statusCode: 403, body: KEYS_WITHHELD_BODY, ...open }]
            }
            // Each placeholder form maps to the same form of the real key (x-api-key raw, `Bearer …`, `token …`).
            const values = placeholderValues(entry, header, value)
            return placeholders.map((placeholder, index) => ({ host: entry.host, header, placeholders: [placeholder], via: 'transform', value: values[index]!, ...open }))
          })
        )
      ]
    : // No proxy (EGRESS-SWAP-FAIL-CLOSED): keys were withheld and only placeholders reached the VM. The firewall
      // answers them itself with a plain error, so agents say what happened instead of a provider auth failure.
      [
        ...egressAccountRoutes(row).flatMap(({ agent, host }): CredentialRoute[] => {
          const provider = accountProvider(agent)
          return provider
            ? [{ host, header: provider.header, placeholders: [provider.format(provider.placeholder(row))], via: 'respond', statusCode: 403, body: KEYS_WITHHELD_BODY }]
            : []
        }),
        ...egressSecretHosts(row).flatMap((entry) =>
          Object.keys(entry.headers).map(
            (header): CredentialRoute => ({
              host: entry.host,
              header,
              placeholders: placeholderValues(entry, header, secretPlaceholder(row, entry.secret)),
              via: 'respond',
              statusCode: 403,
              body: KEYS_WITHHELD_BODY
            })
          )
        )
      ]
  const all = [...git, ...credentials]
  // CODEX-PLACEHOLDER-REFRESH: Codex in the sandbox, answered a 401, refreshes against auth.openai.com with
  // its placeholder login. That request goes to the egress proxy, which answers it with the placeholder
  // again and refreshes the real token centrally (index.ts), so the retry works instead of failing sign-in.
  const codexRefresh = { host: CODEX_AUTH_HOST, path: { exact: '/oauth/token', methods: ['POST'] } }
  const pathForwards = !proxyUrl || !egressAccountRoutes(row).some((route) => route.agent === 'codex')
    ? []
    : firewall?.full && firewall.classes.has('codex')
      ? // Firewall mode answers it here: the placeholder login again (not a secret); the real token is
        // refreshed centrally on schedule (workstream B), never by this request.
        [{ ...codexRefresh, response: { statusCode: 200, contentType: 'application/json', body: codexPlaceholderRefreshBody(row) } }]
      : [{ ...codexRefresh, forwardURL: proxyUrl }]
  if (effectiveEgressPreset(deps, row) === 'open') {
    // Every host is reachable; the credential claims (and their trailing 403s) still apply.
    return compileNetworkPolicy({ mode: 'open', credentials: all, pathForwards })
  }
  // Limited: custom model-provider hosts (ANTHROPIC_BASE_URL / OPENAI_BASE_URL secrets) recorded at
  // boot, MCP hosts the desktop declared, plus operator-configured extra hosts.
  if (deps.config.egressAllowlistError) {
    throw deps.config.egressAllowlistError
  }
  const allowlist = [...new Set([...(deps.config.egressAllowlist ?? DEFAULT_EGRESS_ALLOWLIST), ...(deps.config.extraEgressHosts ?? []), ...egressAllowHosts(row)])]
  return compileNetworkPolicy({ mode: 'allowlist', allowlist, credentials: all, pathForwards })
}

export function sessionFields(deps: LifecycleDeps, state: ProviderSandboxState): SessionFields {
  const now = deps.now()
  const startedAt = state.session.startedAt ?? now
  return {
    session_id: state.session.id,
    session_started_at: startedAt,
    session_deadline_at: startedAt + (deps.config.sessionDeadlineMs ?? SESSION_DEADLINE_MS),
    lease_expires_at: startedAt + state.session.timeoutMs,
    usage_settled_at: startedAt
  }
}

export async function claim(deps: LifecycleDeps, row: SandboxRow, patch: Partial<SandboxRow>): Promise<SandboxRow> {
  const next = await transition(deps.db, row, patch, deps.now())
  if (!next) {
    throw new LifecycleError('conflict', 'concurrent_transition')
  }
  return next
}

export function guardrails(deps: LifecycleDeps): GuardrailConfig {
  return deps.config.guardrails ?? DEFAULT_GUARDRAILS
}

export async function requireStart(deps: LifecycleDeps, accountId: string, userId: string, machineSize: MachineSize) {
  const [, runningSandboxes, runningSandboxesForUser] = await Promise.all([
    assertStartsOpen(deps.db, guardrails(deps)),
    countActiveSandboxes(deps.db, accountId, deps.now()),
    countActiveSandboxesForUser(deps.db, accountId, userId, deps.now())
  ])
  const decision = await deps.entitlements.checkStart({
    accountId,
    machineSize,
    runningSandboxes,
    userId,
    runningSandboxesForUser
  })
  if (decision.suspendRunning) {
    await suspendAccountRunning(deps, accountId)
  }
  if (!decision.allow) {
    throw new LifecycleError('entitlement_denied', decision.reason ?? 'denied')
  }
  await assertAccountCapacity(
    deps.db,
    guardrails(deps),
    accountId,
    { seats: decision.seats, maxConcurrentSandboxes: decision.maxConcurrentSandboxes },
    deps.now()
  )
}

function orcadEndpoint(state: ProviderSandboxState): string | null {
  const route = state.routes.find((candidate) => candidate.port === ORCAD_PORT)
  return route ? route.url.replace(/^https:/, 'wss:') : null
}

async function boot(
  deps: LifecycleDeps,
  row: SandboxRow,
  state: ProviderSandboxState,
  prep: BootPrep,
  options: {
    repo?: { url: string; ref?: string }
    policyApplied: boolean
    timer: ReturnType<typeof phaseTimer>
    /** A pooled VM started before the caller claimed it: usage starts at the claim, not the boot. */
    billFrom?: number
    /** First boot only: prepares the checkout (environment build link, empty repos) before orcad. */
    prelude?: StartInputs['prelude']
    /** A create whose caller installs member git identities after it answers (CREATE-GIT-ASYNC). */
    deferMemberGit?: boolean
  }
): Promise<Ready> {
  if (state.sandbox.tags.orcaSandbox !== row.id) {
    throw new LifecycleError('conflict', 'ownership_mismatch')
  }
  const routed = routedRow(row, prep)
  const git = prep.minted ? { expiresAt: prep.minted.expiresAt } : null
  const gitSetupPending = Boolean(options.deferMemberGit) && memberGitApplies(deps, row)
  // A resumed session keeps its last policy (an expired repo token); swap it in while orcad boots.
  // Nothing in the VM uses git or model keys before orcad answers and the desktop attaches.
  // Member identities count too (GH-ANON-403): a resumed session must not keep a policy written
  // before a fix to its member rules.
  const needsPolicy =
    !options.policyApplied &&
    (git ||
      prep.memberPlaceholders.length > 0 ||
      prep.firewall !== null ||
      routed.egress_secret_hosts ||
      row.egress_secret_hosts ||
      routed.egress_allow_hosts ||
      row.egress_allow_hosts ||
      row.egress_user_hosts)
  // Members revoked while the VM slept must be gone before orcad accepts its first sign-in.
  await applyQueuedRevokes(deps.db, deps.provider, row.id, state.session.id, deps.now())
  const [, connection] = await Promise.all([
    needsPolicy
      ? options.timer.time('policy', () =>
          writeBootPolicy(deps, routed, state.session.id, egressPolicy(deps, routed, prep.minted?.token, prep.memberPlaceholders, prep.firewall))
        )
      : Promise.resolve(),
    options.timer.time('orcad', async () => {
      // Inside the orcad phase (no new build-sheet step): an older image's orcad is brought current first.
      await refreshRuntime(deps, row, state.session.id)
      return startOrcad(deps.provider, state, {
        sandboxId: row.id,
        // The workspace's name, else its repo's: never the provider's per-boot VM id.
        hostname: workspaceHostname(row.name ?? (row.repo_url ? parseGitHubRepo(row.repo_url)?.repo : null)),
        repo: options.repo,
        // Repos hosted outside github.com get no GitHub credential, not even the placeholder.
        githubPlaceholder: deps.config.egressProxyUrl && parseGitHubRepo(row.repo_url ?? '') ? githubPlaceholderToken(row) : undefined,
        ghAsMember: Boolean(deps.config.ghAsMember),
        gitExtraHeader: git ? `Authorization: ${gitBasicAuthorization(githubPlaceholderToken(row))}` : undefined,
        secretEnv: prep.secrets.env,
        docker: deps.config.dockerEnabled !== false,
        shareProxyKey: deps.config.shareLinkSecret
          ? await shareProxyKey(deps.config.shareLinkSecret, row.id, state.session.id)
          : undefined,
        prelude: options.prelude,
        gitSetupPending: gitSetupPending || undefined
      })
    })
  ])
  const readyAt = deps.now()
  await stampBootPolicy(deps, routed)
  const running = await claim(deps, row, {
    status: 'running',
    last_error: null,
    orcad_endpoint: orcadEndpoint(state),
    ready_at: readyAt,
    // Start timings for GET /v1/config: a create is measured from the write-ahead row, a wake from
    // its resume claim. ready_at alone can't tell them apart.
    ...(row.status === 'creating' ? { create_ms: readyAt - row.created_at } : {}),
    ...(row.status === 'resuming' ? { wake_ms: readyAt - row.updated_at } : {}),
    archived_at: null,
    archive_expires_at: null,
    retention_warned_at: null,
    github_token_expires_at: git?.expiresAt ?? null,
    egress_secret_hosts: routed.egress_secret_hosts,
    egress_allow_hosts: routed.egress_allow_hosts,
    ...sessionFields(deps, state),
    ...(options.billFrom !== undefined ? { usage_settled_at: options.billFrom } : {})
  })
  // Per-member git identities for `orca-git-as` (policy routes were refreshed above). A create that
  // defers them (CREATE-GIT-ASYNC) installs them after it answers, once the owner device is recorded.
  if (!gitSetupPending && memberGitApplies(deps, running)) {
    if ((await connectedMembers(deps.db, running)).length > 0) {
      // Recorded like a create's: a failure marks the VM (its git refuses commits and pushes) and the row
      // (gitSetup 'failed'); only a later successful install clears them. Restart re-runs this.
      await settleMemberGit(deps, running, state.session.id, true)
    } else if (running.git_setup_failed_at) {
      // Nobody's identity to install on this boot: nothing is failing any more.
      await deps.db.prepare('UPDATE sandboxes SET git_setup_failed_at = NULL WHERE id = ?').bind(running.id).run()
    }
  }
  await deps.hooks?.afterBoot?.(running, state.session.id).catch(() => undefined)
  // Secrets saved while this VM booted missed prep's env; re-check once it is running (env-refresh.ts).
  const refresh = await import('./env-refresh')
  if (await refresh.envChangedSinceBoot(deps, running, prep.secrets.env).catch(() => false)) {
    const work = refresh.refreshSandboxEnv(deps, running).catch(() => false)
    if (deps.background) {
      deps.background(work)
    }
  }
  return { row: running, connection, timings: options.timer.timings, ...(gitSetupPending ? { gitSetupPending } : {}) }
}

/** Mints a fresh repo token and swaps it into the live policy; null when the repo has no app install. */
export async function refreshGitCredentials(
  deps: LifecycleDeps,
  row: SandboxRow,
  sessionId: string
): Promise<{ expiresAt: number } | null> {
  const applied = await applySandboxPolicy(deps, row, 'git_refresh', { sessionId })
  return applied.gitExpiresAt !== null ? { expiresAt: applied.gitExpiresAt } : null
}

/** @deprecated EGRESS-COMPILE: use applySandboxPolicy (kept one release for callers still on it). */
export async function rewriteLivePolicy(deps: LifecycleDeps, row: SandboxRow, sessionId: string): Promise<{ expiresAt: number } | null> {
  const applied = await applySandboxPolicy(deps, row, 'rewrite', { sessionId })
  return applied.gitExpiresAt !== null ? { expiresAt: applied.gitExpiresAt } : null
}

/**
 * EGRESS-COMPILE: the whole policy for this sandbox from current state. A pure read of credentials (it may
 * mint the GitHub App token, which is idempotent and cached, but never spends a refresh token).
 */
export async function compileSandboxPolicy(
  deps: LifecycleDeps,
  row: SandboxRow,
  options: { tokenFree?: boolean } = {}
): Promise<{ policy: ReturnType<typeof egressPolicy>; gitExpiresAt: number | null }> {
  if (options.tokenFree) {
    // A4: what a stopped sandbox's record keeps. The same routes, but nothing the firewall itself would swap:
    // every firewall value answered by the firewall (respond), no App token. Proxy routes hold no values anyway.
    const [members, firewall] = await Promise.all([memberPlaceholdersFor(deps, row), firewallInputsFor(deps, row)])
    const scrubbed: FirewallInputs | null = firewall
      ? {
          ...firewall,
          classes: new Set([...firewall.classes].filter((name) => name !== 'github_app')),
          accounts: firewall.accounts.map((account) => ({ ...account, authorization: null, accountId: null })),
          secrets: new Map([...firewall.secrets.keys()].map((name) => [name, null]))
        }
      : null
    return { policy: egressPolicy(deps, row, undefined, members, scrubbed), gitExpiresAt: null }
  }
  const [members, firewall, minted] = await Promise.all([
    memberPlaceholdersFor(deps, row),
    firewallInputsFor(deps, row),
    deps.github && row.repo_url ? deps.github.tokenForRepo(row.repo_url, row.account_id) : Promise.resolve(null)
  ])
  return { policy: egressPolicy(deps, row, minted?.token, members, firewall), gitExpiresAt: minted?.expiresAt ?? null }
}

/**
 * A4 primitive (probe 2: the last session policy survives a stop and is re-applied on resume): write the
 * token-free compile to the stopped sandbox's persistent record. Returns the provider's outcome.
 */
/**
 * A4: whether this sandbox's persistent record may hold firewall values: its last applied policy was compiled
 * with a firewall class (the config stamp says), or it would be now. Proxy-only policies hold no values.
 */
export function recordMayHoldValues(deps: Pick<LifecycleDeps, 'config'>, row: SandboxRow): boolean {
  if (firewallClasses(deps, row).size > 0) {
    return true
  }
  try {
    const stamp = JSON.parse(row.policy_config_hash ?? '') as { classes?: unknown[] }
    return Array.isArray(stamp.classes) && stamp.classes.length > 0
  } catch {
    return false
  }
}

/**
 * A4, after a voluntary stop (or a timeout reconcile found): the record gets the token-free policy, so a
 * sleeping workspace keeps no credential at rest in the provider. A failure marks the row for reconcile.
 */
export async function scrubStoppedRecord(deps: LifecycleDeps, row: SandboxRow): Promise<void> {
  if (!recordMayHoldValues(deps, row)) {
    return
  }
  // Review R2: the row may have resumed since it was selected (or since its stop). Only a still-stopped row
  // with no session is scrubbed; a scrub that raced a resume is undone by a fresh apply right after.
  const stopped = (fresh: SandboxRow | null): boolean =>
    fresh !== null && (fresh.status === 'suspended' || fresh.status === 'archived') && !fresh.session_id
  const before = await getSandbox(deps.db, row.id)
  if (!before || !stopped(before)) {
    return
  }
  const outcome = await scrubRecordPolicy(deps, before)
  const after = await getSandbox(deps.db, row.id)
  if (after && !stopped(after) && after.session_id && (after.status === 'running' || after.status === 'resuming')) {
    console.log(JSON.stringify({ event: 'policy_scrub_raced_resume', sandboxId: row.id }))
    await applySandboxPolicy(deps, after, 'scrub_race').catch(() => undefined)
    return
  }
  const ok = outcome === 'scrubbed'
  await deps.db
    .prepare('UPDATE sandboxes SET policy_scrub_pending = ?, policy_scrubbed_at = COALESCE(?, policy_scrubbed_at) WHERE id = ?')
    .bind(ok ? 0 : 1, ok ? deps.now() : null, row.id)
    .run()
  console.log(JSON.stringify({ event: 'policy_record_scrub', sandboxId: row.id, outcome: typeof outcome === 'string' ? outcome : outcome.failed }))
}

/**
 * Stopped rows whose record may still hold values: a failed scrub, or an apply since the last scrub.
 * 'failed' rows are left out on purpose (review R4): failAndRelease destroys their provider sandbox, and the
 * cron retries a destroy that didn't finish, so no record is left to scrub.
 */
export async function rowsToScrub(db: D1Database, limit = 25): Promise<SandboxRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM sandboxes WHERE status IN ('suspended', 'archived') AND destroyed_at IS NULL AND (
         policy_scrub_pending = 1 OR
         (policy_config_hash LIKE '{%' AND policy_config_hash NOT LIKE '%"classes":[]%' AND
          (policy_scrubbed_at IS NULL OR policy_scrubbed_at < COALESCE(policy_generation, 0))))
       LIMIT ?`
    )
    .bind(limit)
    .all<SandboxRow>()
  return results
}

const BOOT_POLICY_BACKOFF_MS = [250, 1000, 3000]

/**
 * A wake's policy write, with backoff. The record it resumes from was scrubbed (A4), so until this lands the
 * firewall answers the placeholders itself (keys-withheld or signed-out errors the agent prints): fail closed,
 * never a hang. If it still fails the workspace opens anyway, marked stale for reconcile's next tick.
 */
async function writeBootPolicy(deps: LifecycleDeps, row: SandboxRow, sessionId: string, policy: ReturnType<typeof egressPolicy>): Promise<void> {
  let failure: unknown = null
  for (let attempt = 0; attempt <= BOOT_POLICY_BACKOFF_MS.length; attempt++) {
    try {
      await deps.provider.updateNetworkPolicy(sessionId, policy)
      return
    } catch (error) {
      failure = error
      const delay = BOOT_POLICY_BACKOFF_MS[attempt]
      if (delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  const code = failure instanceof ProviderError ? (failure.code ?? `status_${failure.status}`) : failure instanceof Error ? failure.name : 'unknown'
  console.error(JSON.stringify({ event: 'policy_apply_failed', sandboxId: row.id, reason: 'boot', narrowing: false, code }))
  await deps.db.prepare('UPDATE sandboxes SET policy_stale_at = ? WHERE id = ?').bind(deps.now(), row.id).run().catch(() => undefined)
}

/** Stamps what a boot's policy was compiled from (A4/§7.2): the create and wake writes don't go through apply. */
async function stampBootPolicy(deps: LifecycleDeps, row: SandboxRow): Promise<void> {
  await deps.db
    .prepare('UPDATE sandboxes SET policy_config_hash = ?, policy_generation = MAX(COALESCE(policy_generation, 0), ?) WHERE id = ?')
    // One below now: the stamp marks that a policy was written, but must never outrank a real apply in the same ms.
    .bind(await policyConfigHash(deps, row), deps.now() - 1, row.id)
    .run()
    .catch(() => undefined)
}

export async function scrubRecordPolicy(deps: LifecycleDeps, row: SandboxRow): Promise<'scrubbed' | 'unsupported' | { failed: string }> {
  if (!deps.provider.updateRecordNetworkPolicy) {
    return 'unsupported'
  }
  try {
    const { policy } = await compileSandboxPolicy(deps, row, { tokenFree: true })
    await deps.provider.updateRecordNetworkPolicy(row.provider_name, policy)
    return 'scrubbed'
  } catch (error) {
    return { failed: error instanceof ProviderError ? (error.code ?? `status_${error.status}`) : error instanceof Error ? error.name : 'unknown' }
  }
}

/**
 * Policy writes that take access away (design §7.1). A narrowing write that still fails after its retries
 * stops the session rather than leave a real credential live in the firewall; any other failure only marks
 * the row stale for reconcile to retry, the old policy staying live meanwhile.
 */
export const NARROWING_POLICY_REASONS: ReadonlySet<string> = new Set([
  'account_revoked',
  'account_signed_out',
  'credential_deleted',
  'share',
  'owner_changed',
  'member_removed',
  'app_uninstalled',
  'binding_revoked',
  'kill_switch',
  'mode_change',
  // An operator input changed (§7.2) in a way that removes access (configChangeNarrows): fails closed like a revoke.
  'config_narrowed'
])

/**
 * Design §7.2: a hash of the operator inputs a policy was compiled from. Reconcile re-applies a running
 * sandbox whose stored hash differs, so a kill switch or class change reaches every live policy in one tick.
 */
export async function policyConfigHash(deps: Pick<LifecycleDeps, 'config' | 'secrets'>, row: Pick<SandboxRow, 'egress_swap_mode'>): Promise<string> {
  const summary = policyConfigSummary(deps, row)
  const inputs = JSON.stringify({
    ...summary,
    allowlist: deps.config.egressAllowlist ?? null,
    extra: deps.config.extraEgressHosts ?? null,
    proxy: Boolean(deps.config.egressProxyUrl)
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(inputs))
  const hash = Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
  // Stored with the inputs that decide narrowing (review F3), so the next change can tell if it removes access.
  return JSON.stringify({ h: hash, ...summary })
}

type PolicyConfigSummary = { mode: EgressSwapMode; classes: string[]; accounts: Record<string, boolean> | null; preset: string | null }

function policyConfigSummary(deps: Pick<LifecycleDeps, 'config' | 'secrets'>, row: Pick<SandboxRow, 'egress_swap_mode'>): PolicyConfigSummary {
  return {
    mode: egressSwapModeFor(deps, row),
    classes: [...firewallClasses(deps, row)].sort(),
    accounts: (deps.secrets?.accountProviders as Record<string, boolean> | undefined) ?? null,
    preset: deps.config.egressPreset ?? null
  }
}

/**
 * Review F3: a config change counts as narrowing (fail closed on a failed write) only when it takes access or
 * custody away: firewall → proxy, a firewall class removed, an account provider turned off, open → limited.
 * Anything else (an allowlist edit, a new class) only marks the row stale on failure. Unreadable history: narrowing.
 */
export function configChangeNarrows(previous: string | null | undefined, next: string): boolean {
  // A pre-F3 stamp (a bare hash, written only in proxy mode on dev) carries no inputs to compare: a retry.
  if (previous != null && !previous.startsWith('{')) {
    return false
  }
  let before: Partial<PolicyConfigSummary>
  let after: PolicyConfigSummary
  try {
    before = JSON.parse(previous ?? '') as Partial<PolicyConfigSummary>
    after = JSON.parse(next) as PolicyConfigSummary
  } catch {
    return true
  }
  if (before.mode === 'firewall' && after.mode !== 'firewall') {
    return true
  }
  if ((before.classes ?? []).some((name) => !after.classes.includes(name))) {
    return true
  }
  if (Object.entries(before.accounts ?? {}).some(([agent, on]) => on && !after.accounts?.[agent])) {
    return true
  }
  return before.preset === 'open' && after.preset !== 'open'
}

const POLICY_WRITE_TRIES = 3
let lastGeneration = 0

export type AppliedPolicy = { applied: boolean; gitExpiresAt: number | null; generation: number | null }

/**
 * EGRESS-COMPILE: THE way to write a running session's policy. Compiles everything from current state, so no
 * writer can drop a class (git route, member identities, account tokens, keys). Ordered by policy_generation:
 * an older compile never lands over a newer one. Values are never logged; failures log the provider's code only.
 */
export function applySandboxPolicy(
  deps: LifecycleDeps,
  row: SandboxRow,
  reason: string,
  options: { sessionId?: string } = {}
): Promise<AppliedPolicy> {
  // No in-isolate chain: a chained promise from a cancelled request would never settle and hang every later
  // write for this sandbox (WORKER-XREQ-PROMISE). Ordering is the D1 generation's job (and review F2's re-check).
  return applyOnce(deps, row, reason, options.sessionId ?? row.session_id)
}

async function applyOnce(deps: LifecycleDeps, row: SandboxRow, reason: string, sessionId: string | null): Promise<AppliedPolicy> {
  if (!sessionId) {
    return { applied: false, gitExpiresAt: null, generation: null }
  }
  const started = deps.now()
  const generation = (lastGeneration = Math.max(lastGeneration + 1, started))
  const claim = await deps.db
    .prepare('UPDATE sandboxes SET policy_generation = ? WHERE id = ? AND (policy_generation IS NULL OR policy_generation < ?)')
    .bind(generation, row.id, generation)
    .run()
  if (claim.meta.changes === 0) {
    // A newer write (another isolate) owns the policy now; it compiled from state at least as fresh.
    return { applied: false, gitExpiresAt: null, generation: null }
  }
  let failure: unknown = null
  for (let attempt = 0; attempt < POLICY_WRITE_TRIES; attempt++) {
    try {
      const { policy, gitExpiresAt } = await compileSandboxPolicy(deps, row)
      await deps.provider.updateNetworkPolicy(sessionId, policy)
      // Review F2: claims are ordered, the writes that land are not. If a newer writer claimed meanwhile, ours may
      // have landed over its policy (one compiled from fresher state, say after a share): write once more, from
      // the state as it is now, so the last write to land is never the stale one.
      const latest = await deps.db.prepare('SELECT policy_generation AS g FROM sandboxes WHERE id = ?').bind(row.id).first<{ g: number | null }>()
      if (latest?.g != null && latest.g > generation) {
        console.log(JSON.stringify({ event: 'policy_superseded', sandboxId: row.id, reason }))
        const fresh = (await getSandbox(deps.db, row.id)) ?? row
        const again = await compileSandboxPolicy(deps, fresh)
        await deps.provider.updateNetworkPolicy(sessionId, again.policy)
        return { applied: true, gitExpiresAt: again.gitExpiresAt, generation: latest.g }
      }
      await deps.db
        .prepare('UPDATE sandboxes SET policy_stale_at = NULL, policy_config_hash = ? WHERE id = ?')
        .bind(await policyConfigHash(deps, row), row.id)
        .run()
      console.log(JSON.stringify({ event: 'policy_applied', sandboxId: row.id, reason, ms: deps.now() - started }))
      return { applied: true, gitExpiresAt, generation }
    } catch (error) {
      failure = error
    }
  }
  const code = failure instanceof ProviderError ? failure.code ?? `status_${failure.status}` : failure instanceof Error ? failure.name : 'unknown'
  const narrowing = NARROWING_POLICY_REASONS.has(reason)
  console.error(JSON.stringify({ event: 'policy_apply_failed', sandboxId: row.id, reason, narrowing, code }))
  if (narrowing) {
    // Fail closed: the old policy may still hold a credential that must be gone now. Sleep it (snapshot kept);
    // if even that fails, stop the session outright.
    const fresh = await getSandbox(deps.db, row.id).catch(() => null)
    const slept = fresh && fresh.status === 'running' ? await suspendSandbox(deps, fresh).then(() => true, () => false) : false
    if (!slept) {
      await deps.provider.stopSession(sessionId).catch(() => undefined)
    }
    console.error(JSON.stringify({ event: 'policy_narrowing_failed', sandboxId: row.id, reason, slept }))
  } else {
    await deps.db.prepare('UPDATE sandboxes SET policy_stale_at = ? WHERE id = ?').bind(deps.now(), row.id).run()
  }
  throw failure
}

/** Sets the workspace placeholder header in the VM user's global git config (no secret: a placeholder). */
export const GIT_EXTRAHEADER_SCRIPT = 'git config --global http.https://github.com/.extraheader "$1"'

export type LiveGitAccess =
  | { applied: true; expiresAt: number }
  | { applied: false; reason: 'not_running' | 'not_github' | 'not_installed' }

/**
 * LIVE-GIT-ACCESS: the GitHub App was installed (or granted the repo) after this workspace booted. Mint the
 * repo token, swap it into the live egress policy, and give the VM's git the placeholder header boot would
 * have set (orca-sandbox-start), so pulls and pushes work without a restart. Idempotent; safe to repeat.
 */
export async function applyLiveGitAccess(deps: LifecycleDeps, row: SandboxRow): Promise<LiveGitAccess> {
  if (row.status !== 'running' || !row.session_id) {
    return { applied: false, reason: 'not_running' }
  }
  if (!row.repo_url || !parseGitHubRepo(row.repo_url)) {
    return { applied: false, reason: 'not_github' }
  }
  const git = await refreshGitCredentials(deps, row, row.session_id)
  if (!git) {
    return { applied: false, reason: 'not_installed' }
  }
  const header = `Authorization: ${gitBasicAuthorization(githubPlaceholderToken(row))}`
  const result = await deps.provider.runCommand(row.session_id, {
    command: 'bash',
    args: ['-c', GIT_EXTRAHEADER_SCRIPT, 'git-access', header],
    timeoutMs: 15_000
  })
  if (result.exitCode !== 0) {
    throw new LifecycleError('conflict', 'git_config_failed')
  }
  await transition(deps.db, row, { github_token_expires_at: git.expiresAt }, deps.now())
  console.log(JSON.stringify({ event: 'git_access_applied', sandboxId: row.id }))
  return { applied: true, expiresAt: git.expiresAt }
}

async function memberPlaceholdersFor(deps: LifecycleDeps, row: SandboxRow): Promise<string[]> {
  if (!deps.memberIdentity || !deps.config.egressProxyUrl || !row.repo_url) {
    return []
  }
  return Promise.all((await connectedMembers(deps.db, row)).map((userId) => memberPlaceholder(row.id, userId)))
}

export const MEMBERS_COMMAND = '/opt/orca/bin/orca-sandbox-members'

/**
 * ENV-STALE boot step: a sandbox whose orcad is behind its region's active golden (booted from an environment
 * build snapshot, or resumed from an older image) installs the golden's runtime bundle before orcad starts.
 * The same command probes the VM's entry points (ENTRY-POINTS-BEFORE-START): scripts older than this
 * Worker's are installed before the start script runs, so the common case adds no round trip.
 * Best effort and quiet: any failure keeps the old orcad and scripts, and every outcome is logged with its timing.
 */
export async function refreshRuntime(deps: LifecycleDeps, row: SandboxRow, sessionId: string): Promise<string | null> {
  if (!deps.runtimeRefresh) {
    return null
  }
  const started = deps.now()
  let result = 'error'
  let target: string | null = null
  let entryPoints = 'unknown'
  try {
    const plan = await deps.runtimeRefresh(row.region, started)
    target = plan?.bundle.commit ?? null
    const run = await deps.provider.runCommand(sessionId, {
      command: 'bash',
      args: ['-c', plan ? `${ENTRY_POINTS_PROBE}\n${RUNTIME_REFRESH_SCRIPT}` : ENTRY_POINTS_PROBE],
      env: plan ? { WANT: plan.bundle.commit, SHA: plan.bundle.sha256, RT: plan.bundle.runtime, URL: plan.url } : {},
      sudo: true,
      timeoutMs: 40_000
    })
    result = plan ? (run.stdout.trim().split('\n').pop() ?? 'error') : 'no_bundle'
    const image = parseEntryPointsProbe(run.stdout)
    entryPoints = entryPointsBehind(image) ? 'behind' : image ? 'current' : 'unknown'
    if (entryPoints === 'behind') {
      entryPoints = await installEntryPoints(deps, sessionId).then(
        () => 'installed',
        () => 'install_failed'
      )
    }
    return result
  } catch {
    return result
  } finally {
    const [outcome, from] = result.split(' ')
    console.log(
      JSON.stringify({
        event: 'runtime_refresh',
        sandboxId: row.id,
        outcome,
        from: from ?? null,
        to: target,
        entryPoints,
        ms: deps.now() - started
      })
    )
  }
}

/**
 * Who may push from this workspace changed (boot, grant, revoke): refresh the egress routes and the
 * VM's per-member git configs (`orca-git-as`). Best effort: a failure leaves pushes on the app identity.
 */
/** Member identities apply: a repo behind the egress proxy, with member identities on. */
export function memberGitApplies(deps: LifecycleDeps, row: Pick<SandboxRow, 'repo_url'>): boolean {
  return Boolean(deps.memberIdentity && deps.config.egressProxyUrl && row.repo_url)
}

export async function syncMemberGit(deps: LifecycleDeps, row: SandboxRow, sessionId: string): Promise<number> {
  if (!memberGitApplies(deps, row)) {
    return 0
  }
  try {
    return await installMemberGit(deps, row, sessionId)
  } catch {
    return 0
  }
}

/** Throws when the VM did not take the identities; on success the VM's setup reads ready. */
async function installMemberGit(deps: LifecycleDeps, row: SandboxRow, sessionId: string): Promise<number> {
  await ensureEntryPoints(deps, sessionId)
  await refreshGitCredentials(deps, row, sessionId)
  const configs = await memberGitConfigs({ db: deps.db, identity: deps.memberIdentity! }, row)
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(configs))))
  const result = await deps.provider.runCommand(sessionId, {
    command: MEMBERS_COMMAND,
    env: { ORCA_MEMBERS_B64: encoded },
    sudo: true,
    timeoutMs: 30_000
  })
  if (result.exitCode !== 0) {
    throw new Error(`members_exit_${result.exitCode}`)
  }
  if (row.git_setup_failed_at) {
    await deps.db.prepare('UPDATE sandboxes SET git_setup_failed_at = NULL WHERE id = ?').bind(row.id).run()
  }
  return configs.length
}

/** Marks this boot's member setup in the VM (its `git` reads it); best effort, a lost mark times out there. */
export const GIT_SETUP_MARK_SCRIPT =
  'state="$HOME/.orca-sandbox"; mkdir -p "$state" && rm -f "$state"/git-setup.pending "$state"/git-setup.ready "$state"/git-setup.failed && date +%s >"$state/git-setup.$1"'

async function markGitSetup(deps: LifecycleDeps, sessionId: string, outcome: 'ready' | 'failed'): Promise<void> {
  await deps.provider
    .runCommand(sessionId, { command: 'bash', args: ['-c', GIT_SETUP_MARK_SCRIPT, 'git-setup', outcome], timeoutMs: 15_000 })
    .catch(() => undefined)
}

/**
 * Installs member identities and records the outcome (CREATE-GIT-ASYNC): after a create answered, and on
 * every later boot that installs them. `install` false (the VM is not running) only marks it. A failure
 * marks the VM (`git-setup.failed`, its git refuses commits and pushes) and the row (gitSetup 'failed')
 * until a later install succeeds.
 */
export async function settleMemberGit(
  deps: LifecycleDeps,
  row: SandboxRow,
  sessionId: string,
  install: boolean
): Promise<'ready' | 'failed'> {
  try {
    if (install) {
      await installMemberGit(deps, row, sessionId)
    } else {
      await markGitSetup(deps, sessionId, 'ready')
    }
    return 'ready'
  } catch (error) {
    console.log(JSON.stringify({ event: 'git_setup_failed', sandboxId: row.id, error: String(error).slice(0, 200) }))
    await markGitSetup(deps, sessionId, 'failed')
    await deps.db
      .prepare('UPDATE sandboxes SET git_setup_failed_at = ? WHERE id = ?')
      .bind(deps.now(), row.id)
      .run()
      .catch(() => undefined)
    return 'failed'
  }
}

export async function createSandbox(
  deps: LifecycleDeps,
  caller: { accountId: string; userId: string },
  request: {
    workspaceId: string
    machineSize: MachineSize
    /** Explicit (the caller's or its project's): authoritative, and never moved by the capacity fallback. */
    region?: string
    /**
     * Served regions nearest the caller first (regions.ts nearestRegions): where a create with nothing
     * pinned starts, and the capacity fallback's order. Absent: the default region, then its fallbacks.
     */
    nearRegions?: readonly string[]
    repo?: { url: string; ref?: string }
    /** Boot from exactly this environment build (bld_...). */
    environmentBuildId?: string
    /** Default true: boot from the active build of the org environment that lists the repo. */
    useEnvironment?: boolean
    title?: string
    visibility?: 'private' | 'team'
    /** Set when an in-VM token of a transferred workspace creates this one: it is transferred too. */
    ownershipTransferredAt?: number | null
    section?: string
    /**
     * The desktop shows the clone as its own step (GET /v1/sandboxes/:id/clone): the repo clones
     * after ready instead of inside it. Older clients wait for the clone inside create.
     */
    cloneInBackground?: boolean
    /** The caller installs member git identities after it answers (CREATE-GIT-ASYNC). */
    deferMemberGit?: boolean
  },
  options: { pool?: boolean; fallback?: boolean } = {}
): Promise<Ready> {
  assertEgressAllowlistUsable(deps, { id: request.workspaceId })
  const existing = await liveSandboxForWorkspace(deps.db, caller.accountId, request.workspaceId)
  if (existing) {
    if (existing.status !== 'running' || !existing.session_id) {
      throw new LifecycleError('conflict', `sandbox_${existing.status}`)
    }
    // Retried create after a lost response: hand back the same environment.
    const state = await deps.provider.getSandbox(existing.provider_name, { resume: false })
    if (!state || state.session.status !== 'running') {
      throw new LifecycleError('conflict', 'sandbox_not_running')
    }
    const connection =
      (await runningOrcad(deps.provider, state.session.id)) ??
      (await startOrcad(deps.provider, state, { sandboxId: existing.id }))
    return { row: existing, connection }
  }
  const timer = phaseTimer(deps.now)
  // An environment build carries the repo prebuilt and its own machine size.
  let source: BootSource | null =
    request.environmentBuildId || request.useEnvironment !== false
      ? await timer.time('environment', () =>
          resolveEnvironmentBoot(deps.db, caller.accountId, {
            repoUrl: request.repo?.url,
            buildId: request.environmentBuildId,
            region: request.region
          })
        )
      : null
  // ENV-BUILD-CHURN (d): never boot a build below the security floor, even while its rebuild runs.
  // The workspace starts from the current golden and clones instead; the desktop says the
  // environment's setup hasn't run (environmentHeld). One rebuild starts behind the response.
  let environmentHeld: Ready['environmentHeld']
  if (source && (await belowSecurityFloor(deps.db, source))) {
    environmentHeld = { environmentId: source.environmentId, reason: 'security_update' }
    source = null
  }
  // An automatic environment is only the repo checked out: the caller's machine size stands.
  const machineSize = source && !source.auto ? source.machineSize : request.machineSize
  await timer.time('entitlement', () => requireStart(deps, caller.accountId, caller.userId, machineSize))
  // A snapshot only boots in its own region: an environment build pins the region it was built in.
  // Then an explicit region; else the nearest served one (each has a golden image).
  const region =
    source?.region ??
    request.region ??
    request.nearRegions?.find((candidate) => goldenFor(deps, candidate)) ??
    deps.config.defaultRegion
  const bootSnapshotId = source?.snapshotId ?? goldenFor(deps, region)
  if (!bootSnapshotId) {
    throw new LifecycleError('conflict', 'region_unavailable')
  }
  // The pool keeps warm VMs per image: the golden one, and the active build of recently used environments.
  const pooled =
    options.pool === false
      ? null
      : await timer.time('pool', () => claimPooledVm(deps, machineSize, region, bootSnapshotId).catch(() => null))
  if (deps.config.pool) {
    // Refill behind the response, on a miss too (empty, or stale after a golden rotation), so the next
    // create finds one without waiting for the cron.
    const refill = maintainPool(deps).catch((error: unknown) =>
      console.log(JSON.stringify({ event: 'pool_refill_failed', error: String(error).slice(0, 200) }))
    )
    deps.background?.(refill)
  }
  const claimedAt = deps.now()
  // In the background after ready: a clone, or (an environment build carries the repo prebuilt) a fetch
  // of what changed since the build.
  const cloning: Ready['cloning'] = request.repo && request.cloneInBackground ? (source?.repoDir ? 'update' : 'clone') : undefined
  const prelude: StartInputs['prelude'] = request.repo
    ? {
        script: WORKSPACE_PRELUDE_SCRIPT,
        env: {
          ...(source?.repoDir ? { ORCA_ENV_REPO_DIR: source.repoDir } : {}),
          ...(cloning ? { ORCA_CLONE_BACKGROUND: '1' } : {})
        }
      }
    : undefined
  const id = pooled?.id ?? randomId()
  // Write-ahead row and the VM-independent prep (secrets, repo token) run together.
  const [row, prep] = await timer.time('prepare', async () => {
    const inserted = await insertSandbox(
      deps.db,
      {
        id,
        account_id: caller.accountId,
        user_id: caller.userId,
        workspace_id: request.workspaceId,
        provider: 'vercel',
        provider_name: `orca-${deps.config.environment}-${id}`,
        machine_size: machineSize,
        region,
        repo_url: request.repo?.url ?? null,
        environment_id: source?.environmentId ?? null,
        environment_build_id: source?.buildId ?? null,
        source_snapshot_id: bootSnapshotId,
        repo_branch: request.repo?.ref ?? null,
        name: request.title ?? null,
        // A personal account has no team: its workspaces are always private.
        visibility: request.visibility === 'team' && caller.accountId.includes('org:') ? 'team' : 'private',
        section: request.section ?? null,
        ownership_transferred_at: request.ownershipTransferredAt ?? null
      },
      deps.now()
    ).catch(async (error: unknown) => {
      if (pooled) {
        await deletePooledVm(deps, pooled.provider_name, pooled.snapshot_id).catch(() => undefined)
      }
      throw error
    })
    try {
      const prepared = await prepareBoot(deps, inserted)
      await assertRepoReachable(deps, inserted, prepared)
      return [inserted, prepared] as const
    } catch (error) {
      // Nothing booted for this row yet (a pooled VM goes with it): fail it before any VM work.
      await failAndRelease(deps, inserted, createFailureReason(error))
      throw error
    }
  })
  // ENV-BUILD-CHURN (b): every environment boot records the use (org environments too) and may start
  // the lazy refresh; an environment held off by the floor starts its one rebuild here.
  const usedEnvironmentId = source?.environmentId ?? environmentHeld?.environmentId
  if (usedEnvironmentId && deps.environmentUsed) {
    deps.background?.(deps.environmentUsed(usedEnvironmentId).catch(() => undefined))
  }
  // The repo is reachable: the next create of it should find it prebuilt (auto-environments.ts).
  if (
    request.repo &&
    deps.autoEnvironment &&
    !environmentHeld &&
    !request.environmentBuildId &&
    request.useEnvironment !== false
  ) {
    const work = source?.auto
      ? deps.autoEnvironment.touch(source.environmentId)
      : !source
        ? deps.autoEnvironment.ensure(caller.accountId, request.repo.url, region)
        : null
    if (work) {
      const settled = work.catch(() => undefined)
      deps.background?.(settled)
    }
  }
  if (pooled) {
    try {
      const state = await timer.time('vm', () =>
        adoptPooledVm(deps, pooled, egressPolicy(deps, routedRow(row, prep), prep.minted?.token, prep.memberPlaceholders, prep.firewall))
      )
      const ready = await boot(deps, row, state, prep, {
        repo: request.repo,
        policyApplied: true,
        timer,
        billFrom: claimedAt,
        prelude,
        deferMemberGit: request.deferMemberGit
      })
      console.log(JSON.stringify({ event: 'lifecycle_timing', op: 'create', pooled: true, ms: timer.timings }))
      return { ...ready, ...(cloning ? { cloning } : {}), ...(environmentHeld ? { environmentHeld } : {}) }
    } catch (error) {
      // EP-5: deleted by its owner mid-create (a cancel): free it, never make another.
      const cancelled = await deletedMeanwhile(deps, row)
      // A pooled VM that will not take the session is discarded; the caller still gets a workspace.
      console.log(JSON.stringify({ event: 'pool_adopt_failed', error: String(error).slice(0, 200) }))
      await failAndRelease(deps, (await getSandbox(deps.db, row.id)) ?? row, createFailureReason(error, timer))
      if (cancelled) {
        throw new LifecycleError('conflict', CREATE_CANCELLED)
      }
      // A boot that ran long (the start command timed out) would only time out again on a fresh VM,
      // doubling the wait the user sees: only a quick failure, which points at the pooled VM, retries.
      if (deps.now() - claimedAt > POOL_RETRY_WITHIN_MS) {
        throw error
      }
      // Destroy can stop short (e.g. the provider's delete snapshot is still being written); the cron
      // finishes it. That row never held user data, so it lets go of the workspace now.
      await detachFromWorkspace(deps.db, row.id)
      return createSandbox(deps, caller, request, { pool: false })
    }
  }
  let state: ProviderSandboxState
  try {
    // The full policy (repo token, model-key routes) goes in at create: no second policy round trip.
    const createVm = () =>
      deps.provider.createSandbox({
        name: row.provider_name,
        snapshotId: bootSnapshotId,
        vcpus: SANDBOX_VCPUS,
        region: row.region,
        timeoutMs: LEASE_MS,
        ports: [ORCAD_PORT, SHARE_PROXY_PORT],
        networkPolicy: egressPolicy(deps, routedRow(row, prep), prep.minted?.token, prep.memberPlaceholders, prep.firewall),
        snapshotExpirationMs: deps.config.snapshotExpirationMs ?? DEFAULT_SNAPSHOT_EXPIRATION_MS,
        tags: { orcaSandbox: row.id, orcaEnv: deps.config.environment }
      })
    state = await timer.time('vm', async () => {
      try {
        return await createVm()
      } catch (error) {
        // Never for a create its owner deleted meanwhile (a cancel's delete also makes the provider 404).
        if (!freshBuildSnapshot404(error, source, deps.now()) || (await deletedMeanwhile(deps, row))) {
          throw error
        }
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
        await sleep(FRESH_BUILD_RETRY_WAIT_MS)
        try {
          const retried = await createVm()
          console.log(JSON.stringify({ event: 'fresh_build_snapshot_retry', buildId: source.buildId, ok: true }))
          return retried
        } catch (again) {
          console.log(JSON.stringify({ event: 'fresh_build_snapshot_retry', buildId: source.buildId, ok: false, error: String(again).slice(0, 200) }))
          throw again
        }
      }
    })
  } catch (error) {
    const cancelled = await deletedMeanwhile(deps, row)
    await failAndRelease(deps, (await getSandbox(deps.db, row.id)) ?? row, createFailureReason(error))
    if (cancelled) {
      throw new LifecycleError('conflict', CREATE_CANCELLED)
    }
    // Only a create nothing pinned to a region moves on: no explicit region, no environment build.
    const fallback =
      options.fallback !== false && !request.region && !source && isRegionalFailure(error)
        ? (request.nearRegions ?? deps.config.fallbackRegions)?.find((candidate) => candidate !== region && goldenFor(deps, candidate))
        : undefined
    if (fallback) {
      console.log(JSON.stringify({ event: 'region_fallback', from: region, to: fallback, error: String(error).slice(0, 200) }))
      // The failed row never got a VM; it lets go of the workspace so the retry can take it.
      await detachFromWorkspace(deps.db, row.id)
      return createSandbox(deps, caller, { ...request, region: fallback }, { pool: false, fallback: false })
    }
    throw error
  }
  try {
    const ready = await boot(deps, row, state, prep, { repo: request.repo, policyApplied: true, timer, prelude, deferMemberGit: request.deferMemberGit })
    console.log(JSON.stringify({ event: 'lifecycle_timing', op: 'create', fromBuild: source?.buildId ?? null, ms: timer.timings }))
    return { ...ready, ...(cloning ? { cloning } : {}), ...(environmentHeld ? { environmentHeld } : {}) }
  } catch (error) {
    await failAndRelease(deps, (await getSandbox(deps.db, row.id)) ?? row, createFailureReason(error, timer))
    throw error
  }
}

/**
 * last_error for a create that failed with `error`: the step that broke, never a message. An error of
 * no known kind is named by the phase it broke (`timer`): orcad's start, at or past its 120 s budget,
 * is `orcad_start_timeout` (CREATE-FAIL-LABELS), so D1 alone tells a hung start from the rest.
 */
export function createFailureReason(error: unknown, timer?: Pick<ReturnType<typeof phaseTimer>, 'failed'>): string {
  if (error instanceof VmCommandError) {
    return error.code
  }
  if (error instanceof LifecycleError) {
    return error.reason ?? error.code
  }
  if (error instanceof ProviderError) {
    return `provider_${error.status}`
  }
  if (timer?.failed?.phase === 'orcad') {
    return timer.failed.ms >= START_TIMEOUT_MS ? 'orcad_start_timeout' : 'orcad_start_error'
  }
  return 'create_failed'
}

async function assertRepoReachable(deps: LifecycleDeps, row: SandboxRow, prep: BootPrep): Promise<void> {
  if (!row.repo_url || prep.minted || !deps.publicRepoCheck || !parseGitHubRepo(row.repo_url)) {
    return
  }
  if (!(await deps.publicRepoCheck(row.repo_url))) {
    throw new LifecycleError('conflict', 'github_not_connected')
  }
}

/** Hands a pooled VM the caller's policy and a full lease; the three provider calls run together. */
async function adoptPooledVm(
  deps: LifecycleDeps,
  pooled: PooledVm,
  policy: ReturnType<typeof egressPolicy>
): Promise<ProviderSandboxState> {
  if (!pooled.session_id || pooled.session_started_at === null || pooled.session_timeout_ms === null) {
    throw new LifecycleError('provider_unavailable', 'pooled_vm_incomplete')
  }
  const sessionId = pooled.session_id
  const leaseEnd = deps.now() + LEASE_MS
  const timeoutEnd = pooled.session_started_at + pooled.session_timeout_ms
  const [state, , extended] = await Promise.all([
    deps.provider.getSandbox(pooled.provider_name, { resume: false }),
    deps.provider.updateNetworkPolicy(sessionId, policy),
    leaseEnd > timeoutEnd ? deps.provider.extendTimeout(sessionId, leaseEnd - timeoutEnd) : Promise.resolve(null)
  ])
  if (!state || state.session.status !== 'running' || state.session.id !== sessionId) {
    throw new LifecycleError('provider_unavailable', 'pooled_vm_gone')
  }
  return extended ? { ...state, session: { ...state.session, timeoutMs: extended.timeoutMs } } : state
}

/**
 * Billing says the account's payment grace ran out: stop (snapshot-preserving, never destroy) every
 * running sandbox. Resume stays refused by the start check until billing allows starts again.
 */
export async function suspendAccountRunning(deps: LifecycleDeps, accountId: string): Promise<number> {
  let suspended = 0
  for (const row of await listAccountSandboxes(deps.db, accountId)) {
    if (row.status !== 'running') {
      continue
    }
    try {
      await suspendSandbox(deps, row)
      suspended++
    } catch {
      // A concurrent transition or provider hiccup; the next cron pass retries.
    }
  }
  return suspended
}

/**
 * A create that never became usable is destroyed now; the cron retries if this also fails.
 * `reason` lands in last_error, so a failed create says why (create_failed when nothing more is known).
 */
export async function failAndRelease(deps: LifecycleDeps, row: SandboxRow, reason = 'create_failed'): Promise<void> {
  const failed = await transition(deps.db, row, { status: 'failed', last_error: reason }, deps.now())
  if (failed) {
    await destroySandbox(deps, failed).catch(() => undefined)
  }
}

export async function stopForSuspend(
  deps: LifecycleDeps,
  row: SandboxRow,
  options: { drainSeconds?: number; reason?: 'sleep' | 'rollover'; captureRead?: boolean } = {}
): Promise<SandboxRow> {
  if (row.session_id) {
    // While orcad still serves: what a sleeping workspace shows to readers (sealed on the VM).
    // Skipped for Restart (orcad isn't answering) and Archive (an archived workspace isn't readable).
    if (options.captureRead !== false) {
      await captureReadSnapshot(deps, row, options.reason ?? 'sleep').catch(() => undefined)
    }
    await drainOrcad(deps.provider, row.session_id, options.drainSeconds)
    const stopped = await deps.provider.stopSession(row.session_id)
    if (stopped.snapshotId) {
      await recordSnapshots(deps.db, row.id, [stopped.snapshotId], deps.now())
    }
    await queueUsage(deps.db, row, deps.now())
    // Internal CPU review (U22): never throws, never touches the meter.
    await recordSessionEnd(deps.db, row, deps.now(), stopped.usage, deps.now())
  } else {
    await queueUsage(deps.db, row, deps.now())
  }
  await deps.hooks?.afterStop?.(row).catch(() => undefined)
  const suspended = await claim(deps, row, { status: 'suspended', ...NO_SESSION })
  // A4: the stopped record keeps the session's last policy; leave it token-free.
  await scrubStoppedRecord(deps, suspended).catch(() => undefined)
  return suspended
}

/** The provider ended the session on its own (lease lapsed): bill up to when it stopped. */
export async function markProviderStopped(deps: LifecycleDeps, row: SandboxRow): Promise<SandboxRow> {
  const endedAt = Math.min(deps.now(), row.lease_expires_at ?? deps.now())
  await queueUsage(deps.db, row, endedAt)
  await recordSessionEnd(deps.db, row, endedAt, null, deps.now())
  await deps.hooks?.afterStop?.(row).catch(() => undefined)
  const suspended = await claim(deps, row, { status: 'suspended', ...NO_SESSION })
  // A4: a timeout kept the last policy on the record too.
  await scrubStoppedRecord(deps, suspended).catch(() => undefined)
  return suspended
}

export async function suspendSandbox(deps: LifecycleDeps, row: SandboxRow): Promise<SandboxRow> {
  // Archived is already stopped (the desktop's Sleep runs after or before an archive).
  if (row.status === 'suspended' || row.status === 'archived') {
    return row
  }
  if (row.status !== 'running') {
    throw new LifecycleError('conflict', `sandbox_${row.status}`)
  }
  // Read while orcad still serves: an asleep archive or delete can then ask before waking it for the hook.
  await learnArchiveHook(deps.provider, deps.db, row)
  const suspending = await claim(deps, row, { status: 'suspending' })
  const suspended = await stopForSuspend(deps, suspending)
  await flushUsage(deps.db, deps.entitlements, deps.now(), row.id)
  return suspended
}

export async function resumeSandbox(deps: LifecycleDeps, row: SandboxRow): Promise<Ready> {
  assertEgressAllowlistUsable(deps, row)
  if (row.status === 'resuming') {
    const settled = await joinOrAdoptResume(deps, row)
    if ('connection' in settled) {
      return settled
    }
    row = settled
  }
  if (row.status === 'running') {
    const state = await deps.provider.getSandbox(row.provider_name, { resume: false })
    if (state?.session.status === 'running') {
      // Idempotent: a running, serving sandbox answers at once (desktop wake-on-open after a restart).
      return adoptRunning(deps, row, state)
    }
    // The provider ended the session (lease lapsed): fall through to a real resume.
    row = await markProviderStopped(deps, row)
  }
  if (row.status !== 'suspended') {
    throw new LifecycleError('conflict', `sandbox_${row.status}`)
  }
  await requireStart(deps, row.account_id, row.user_id, row.machine_size)
  const resuming = await claim(deps, row, { status: 'resuming' })
  return wake(deps, resuming)
}

/**
 * RESUME-STUCK: a wake is already in flight (a second open, or one whose client quit mid-wake). Wait
 * for it; once it is stale its Worker is gone, so adopt what the provider says: a running session
 * gets the full boot, otherwise the row goes back to `suspended` and this resume starts a fresh one.
 */
async function joinOrAdoptResume(deps: LifecycleDeps, row: SandboxRow): Promise<Ready | SandboxRow> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = deps.now() + RESUME_JOIN_MS
  let current = row
  while (current.status === 'resuming' && deps.now() - current.updated_at < RESUME_STALE_MS && deps.now() < deadline) {
    await sleep(RESUME_POLL_MS)
    current = (await getSandbox(deps.db, row.id)) ?? current
  }
  if (current.status !== 'resuming') {
    return current
  }
  if (deps.now() - current.updated_at < RESUME_STALE_MS) {
    throw new LifecycleError('conflict', 'sandbox_resuming')
  }
  console.log(JSON.stringify({ event: 'resume_adopted_stale', sandboxId: row.id, staleMs: deps.now() - current.updated_at }))
  const state = await deps.provider.getSandbox(current.provider_name, { resume: false })
  if (state?.session.status === 'running') {
    return bootLiveSession(deps, current, state)
  }
  return markProviderStopped(deps, current)
}

/**
 * A running session whose orcad may not be up (a retried call, or a row the cron repaired after a
 * wake died mid-way): start orcad (idempotent per boot) and record its endpoint if missing.
 */
export async function adoptRunning(deps: LifecycleDeps, row: SandboxRow, state: ProviderSandboxState): Promise<Ready> {
  const connection =
    (await runningOrcad(deps.provider, state.session.id)) ?? (await startOrcad(deps.provider, state, { sandboxId: row.id }))
  if (row.orcad_endpoint && row.ready_at !== null) {
    return { row, connection }
  }
  const updated = await transition(deps.db, row, { orcad_endpoint: orcadEndpoint(state), ready_at: deps.now() }, deps.now())
  return { row: updated ?? row, connection }
}

/**
 * The VM is running but the boot that should have followed never finished (its Worker was cut
 * off, or the cron adopted the session): run the full boot — secrets, repo token, egress policy,
 * orcad — against the live session, exactly as a wake would.
 */
export async function bootLiveSession(deps: LifecycleDeps, row: SandboxRow, state: ProviderSandboxState): Promise<Ready> {
  const timer = phaseTimer(deps.now)
  const prep = await timer.time('prepare', () => prepareBoot(deps, row))
  return boot(deps, row, state, prep, {
    policyApplied: false,
    timer,
    // Re-booting orcad in an already-metered session keeps its usage cursor (no re-billing).
    billFrom: row.status === 'running' && row.usage_settled_at !== null ? row.usage_settled_at : undefined
  })
}

export async function wake(deps: LifecycleDeps, row: SandboxRow): Promise<Ready> {
  assertEgressAllowlistUsable(deps, row)
  await resetArchiveHookMemo(deps.db, row.id).catch(() => undefined)
  const timer = phaseTimer(deps.now)
  // A4: the record was scrubbed at stop; give it the full policy first so the resumed session has no gap.
  // Best effort: the post-resume apply in boot is the backstop.
  if (recordMayHoldValues(deps, row) && deps.provider.updateRecordNetworkPolicy) {
    await timer
      .time('policy-record', async () => deps.provider.updateRecordNetworkPolicy!(row.provider_name, (await compileSandboxPolicy(deps, row)).policy))
      .catch(() => undefined)
  }
  // The provider boot is the long pole; secrets and the repo token resolve alongside it.
  const [state, prep] = await Promise.all([
    timer.time('vm', () => deps.provider.getSandbox(row.provider_name, { resume: true })),
    timer.time('prepare', () => prepareBoot(deps, row))
  ])
  if (!state) {
    await claim(deps, row, { status: 'failed', last_error: 'provider_sandbox_missing' })
    throw new LifecycleError('conflict', 'environment_missing')
  }
  try {
    const ready = await boot(deps, row, state, prep, { policyApplied: false, timer })
    console.log(JSON.stringify({ event: 'lifecycle_timing', op: 'wake', ms: timer.timings }))
    return ready
  } catch (error) {
    // Leave it resumable: the disk is intact, only this boot failed.
    const current = await getSandbox(deps.db, row.id)
    // Only undo our own claim: a Restart that took the row over owns it now.
    if (current?.status === 'resuming' && current.generation === row.generation) {
      await transition(deps.db, current, { status: 'suspended', ...NO_SESSION, last_error: 'resume_failed' }, deps.now())
      await deps.hooks?.afterStop?.(current).catch(() => undefined)
    }
    throw error
  }
}

/** 24h cap or opportunistic refresh: drain, stop (snapshot), boot the same disk again. */
export async function rolloverSandbox(deps: LifecycleDeps, row: SandboxRow): Promise<Ready> {
  if (row.status !== 'running') {
    throw new LifecycleError('conflict', `sandbox_${row.status}`)
  }
  if (await killSwitchOn(deps.db, guardrails(deps))) {
    throw new GuardrailError('maintenance')
  }
  const suspending = await claim(deps, row, { status: 'suspending' })
  const stopped = await stopForSuspend(deps, suspending, { reason: 'rollover' })
  await flushUsage(deps.db, deps.entitlements, deps.now(), row.id)
  return wake(deps, await claim(deps, stopped, { status: 'resuming' }))
}

export async function renewLease(deps: LifecycleDeps, row: SandboxRow, extendMs: number): Promise<SandboxRow> {
  if (row.status !== 'running' || !row.session_id || row.lease_expires_at === null || row.session_deadline_at === null) {
    throw new LifecycleError('conflict', `sandbox_${row.status}`)
  }
  const target = Math.min(row.session_deadline_at, deps.now() + extendMs)
  if (target <= row.lease_expires_at) {
    return row
  }
  const session = await deps.provider.extendTimeout(row.session_id, target - row.lease_expires_at)
  const startedAt = row.session_started_at ?? deps.now()
  return claim(deps, row, { lease_expires_at: startedAt + session.timeoutMs })
}

export async function destroySandbox(deps: LifecycleDeps, row: SandboxRow): Promise<SandboxRow> {
  if (row.status === 'destroyed') {
    return row
  }
  let destroying = row.status === 'destroying' ? row : await claim(deps, row, { status: 'destroying' })
  const settled = await queueUsage(deps.db, destroying, deps.now())
  // A live session ends with the delete (no-op once suspended: the row has no session then).
  await recordSessionEnd(deps.db, destroying, deps.now(), null, deps.now())
  if (settled !== destroying.usage_settled_at) {
    destroying = await claim(deps, destroying, { usage_settled_at: settled })
  }
  // A9: sign each agent out on the VM first (bounded, best effort; never blocks the delete). A
  // suspended sandbox has no session and is never woken for it: its disk goes with the delete.
  // A retried destroy already tried once, and its box may be gone: don't wait on it again.
  if (destroying.session_id && row.status !== 'destroying') {
    await signOutAgentsBeforeDelete(deps.provider, destroying.session_id, { sandboxId: row.id })
  }
  await deps.provider.deleteSandbox(destroying.provider_name)
  // Persistent sandboxes leave automatic snapshots behind delete; prove none survive.
  const listed = await deps.provider.listSnapshots(destroying.provider_name)
  await recordSnapshots(deps.db, row.id, listed.map((s) => s.id), deps.now())
  // The image it booted from (golden or an environment build) is shared: never this sandbox's to delete.
  const shared = new Set([...goldenSnapshotIds(deps.config), row.source_snapshot_id].filter((id): id is string => !!id))
  for (const id of await recordedSnapshotIds(deps.db, row.id)) {
    if (!shared.has(id)) {
      await deps.provider.deleteSnapshot(id)
    }
  }
  const remaining = (await deps.provider.listSnapshots(destroying.provider_name)).filter(
    (s) => s.status !== 'deleted' && !shared.has(s.id)
  )
  if (remaining.length > 0) {
    throw new LifecycleError('provider_unavailable', 'snapshot_cleanup_incomplete')
  }
  await markSnapshotsDeleted(deps.db, row.id, deps.now())
  // Archive metadata (repo state, file tree) goes with the workspace.
  await deps.db.prepare('DELETE FROM sandbox_archives WHERE sandbox_id = ?').bind(row.id).run()
  // Nobody follows a workspace that is gone (PARITY-FOLLOW).
  await forgetWorkspaceFollows(deps.db, row.id)
  // So does its sealed read snapshot.
  await deleteReadSnapshot(deps.db, row.id)
  // And its per-workspace agent Source overrides.
  await deleteAgentSourcesForSandbox(deps.db, row.id)
  const destroyed = await claim(deps, destroying, {
    status: 'destroyed',
    ...NO_SESSION,
    destroyed_at: deps.now(),
    // Tombstone: the row stays for usage/audit, the workspace's repository does not.
    repo_url: null
  })
  await flushUsage(deps.db, deps.entitlements, deps.now(), row.id)
  await deps.hooks?.afterStop?.(destroyed).catch(() => undefined)
  return destroyed
}

/**
 * EP-5: a create whose row its owner deleted mid-way (a cancelled create; the create outlives its
 * request). It frees what it made and stops: no pooled retry, no region fallback, no new row.
 */
export const CREATE_CANCELLED = 'create_cancelled'

async function deletedMeanwhile(deps: LifecycleDeps, row: SandboxRow): Promise<boolean> {
  const current = await getSandbox(deps.db, row.id)
  return current?.status === 'destroying' || current?.status === 'destroyed'
}
