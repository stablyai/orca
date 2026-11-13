// Sandbox lifecycle: one persistent provider sandbox per Orca workspace, with an Orca-owned lease,
// a forced stop before the provider's 24h cap, usage metering and write-ahead rows.
import { accountProvider } from './account-providers'
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
import { DEFAULT_EGRESS_ALLOWLIST, DEFAULT_EGRESS_PRESET, compileNetworkPolicy, gitBasicAuthorization, type CredentialRoute, type EgressPreset } from './network-policy'
import { applyQueuedRevokes } from './grant-revokes'
import { ensureEntryPoints } from './golden-images'
import { RUNTIME_REFRESH_SCRIPT, type RuntimeBundle } from './runtime-bundles'
import { memberPlaceholder, type MemberGitIdentity } from './github-user-tokens'
import { connectedMembers, memberGitConfigs } from './member-git'
import type { RetentionConfig } from './retention'
import { ProviderError, type ProviderSandboxState, type SandboxProviderApi } from './sandbox-provider'
import { egressAccountRoutes, egressSecretHosts, placeholderValues, secretPlaceholder } from './secret-egress'
import { egressAllowHosts, sessionSecretEnv, type SessionSecrets } from './session-env'
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
  type StartInputs
} from './sandbox-vm-commands'
import { WORKSPACE_PRELUDE_SCRIPT } from '../image/vm-scripts.generated'
import { resolveEnvironmentBoot, type BootSource } from './environments'
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
    ensure(accountId: string, repoUrl: string): Promise<unknown>
    touch(environmentId: string): Promise<unknown>
  }
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
    /** Hosts allowed on top of the default egress allowlist (e.g. this control plane for the in-VM CLI). */
    extraEgressHosts?: readonly string[]
    /** Workspace sandbox egress (SANDBOX_EGRESS_PRESET); default DEFAULT_EGRESS_PRESET ("open"). */
    egressPreset?: EgressPreset
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
}

/** Phase durations for one lifecycle call (logged + Server-Timing); counts only, no ids or secrets. */
export function phaseTimer(now: () => number = Date.now) {
  const timings: Record<string, number> = {}
  return {
    timings,
    async time<T>(phase: string, work: () => Promise<T>): Promise<T> {
      const started = now()
      try {
        return await work()
      } finally {
        timings[phase] = now() - started
      }
    }
  }
}

type BootPrep = {
  secrets: SessionSecrets
  minted: { token: string; expiresAt: number } | null
  /** Members whose own GitHub identity this session may use (git as the sender). */
  memberPlaceholders: string[]
}

/** Everything a boot needs that does not depend on the VM: resolved concurrently with the VM work. */
async function prepareBoot(deps: LifecycleDeps, row: SandboxRow): Promise<BootPrep> {
  const [secrets, minted, memberPlaceholders] = await Promise.all([
    sessionSecretEnv(deps, row),
    deps.github && row.repo_url ? deps.github.tokenForRepo(row.repo_url, row.account_id) : Promise.resolve(null),
    memberPlaceholdersFor(deps, row)
  ])
  return { secrets, minted, memberPlaceholders }
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

export function egressPolicy(deps: LifecycleDeps, row: SandboxRow, gitToken?: string, memberPlaceholders: readonly string[] = []) {
  const proxyUrl = deps.config.egressProxyUrl
  const gitPlaceholder = gitBasicAuthorization(githubPlaceholderToken(row))
  // The workspace repo's installation token. With the egress proxy (every deployed env) it is forwarded and
  // swapped there, so the real token never sits in Vercel's policy store; the inline transform is the
  // no-proxy fallback only (git/libcurl is unaffected by the transform framing hang).
  const git: CredentialRoute[] = !gitToken
    ? []
    : proxyUrl
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
                forwardURL: proxyUrl
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
        {
          host: 'api.github.com',
          header: 'authorization',
          placeholders: githubPlaceholderHeaders(row),
          via: 'forward',
          forwardURL: proxyUrl
        },
        // Model API keys swapped at egress (phase 2); each host also ends in the 403 deny rule, except a
        // host whose client sends its own short-lived token on later calls (Cursor).
        // An agent's Orca-account placeholder (D10): forwarded, claimed only by that exact Bearer value.
        ...egressAccountRoutes(row).flatMap(({ agent, host }): CredentialRoute[] => {
          const provider = accountProvider(agent)
          return provider
            ? [{ host, header: provider.header, placeholders: [provider.format(provider.placeholder(row))], via: 'forward', forwardURL: proxyUrl }]
            : []
        }),
        ...egressSecretHosts(row).flatMap((entry) =>
          Object.keys(entry.headers).map(
            (header): CredentialRoute => ({
              host: entry.host,
              header,
              placeholders: placeholderValues(entry, header, secretPlaceholder(row, entry.secret)),
              via: 'forward',
              forwardURL: proxyUrl,
              ...(entry.allowUnclaimed ? { allowUnclaimed: true } : {})
            })
          )
        )
      ]
    : []
  const all = [...git, ...credentials]
  if ((deps.config.egressPreset ?? DEFAULT_EGRESS_PRESET) === 'open') {
    // Every host is reachable; the credential claims (and their trailing 403s) still apply.
    return compileNetworkPolicy({ mode: 'open', credentials: all })
  }
  // Limited: custom model-provider hosts (ANTHROPIC_BASE_URL / OPENAI_BASE_URL secrets) recorded at
  // boot, MCP hosts the desktop declared, plus operator-configured extra hosts.
  const allowlist = [...new Set([...(deps.config.egressAllowlist ?? DEFAULT_EGRESS_ALLOWLIST), ...(deps.config.extraEgressHosts ?? []), ...egressAllowHosts(row)])]
  return compileNetworkPolicy({ mode: 'allowlist', allowlist, credentials: all })
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
  const needsPolicy =
    !options.policyApplied &&
    (git || routed.egress_secret_hosts || row.egress_secret_hosts || routed.egress_allow_hosts || row.egress_allow_hosts || row.egress_user_hosts)
  // Members revoked while the VM slept must be gone before orcad accepts its first sign-in.
  await applyQueuedRevokes(deps.db, deps.provider, row.id, state.session.id, deps.now())
  const [, connection] = await Promise.all([
    needsPolicy
      ? options.timer.time('policy', () =>
          deps.provider.updateNetworkPolicy(state.session.id, egressPolicy(deps, routed, prep.minted?.token, prep.memberPlaceholders))
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
        gitExtraHeader: git ? `Authorization: ${gitBasicAuthorization(githubPlaceholderToken(row))}` : undefined,
        secretEnv: prep.secrets.env,
        shareProxyKey: deps.config.shareLinkSecret
          ? await shareProxyKey(deps.config.shareLinkSecret, row.id, state.session.id)
          : undefined,
        prelude: options.prelude,
        gitSetupPending: gitSetupPending || undefined
      })
    })
  ])
  const readyAt = deps.now()
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
  const members = await memberPlaceholdersFor(deps, row)
  const minted = deps.github && row.repo_url ? await deps.github.tokenForRepo(row.repo_url, row.account_id) : null
  if (!minted) {
    if (members.length > 0) {
      await deps.provider.updateNetworkPolicy(sessionId, egressPolicy(deps, row, undefined, members))
    }
    return null
  }
  await deps.provider.updateNetworkPolicy(sessionId, egressPolicy(deps, row, minted.token, members))
  return { expiresAt: minted.expiresAt }
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
 * Best effort and quiet: any failure keeps the old orcad, and every outcome is logged with its timing.
 */
export async function refreshRuntime(deps: LifecycleDeps, row: SandboxRow, sessionId: string): Promise<string | null> {
  if (!deps.runtimeRefresh) {
    return null
  }
  const started = deps.now()
  let result = 'error'
  let target: string | null = null
  try {
    const plan = await deps.runtimeRefresh(row.region, started)
    if (!plan) {
      result = 'no_bundle'
      return result
    }
    target = plan.bundle.commit
    const run = await deps.provider.runCommand(sessionId, {
      command: 'bash',
      args: ['-c', RUNTIME_REFRESH_SCRIPT],
      env: { WANT: plan.bundle.commit, SHA: plan.bundle.sha256, RT: plan.bundle.runtime, URL: plan.url },
      sudo: true,
      timeoutMs: 40_000
    })
    result = run.stdout.trim().split('\n').pop() ?? 'error'
    return result
  } catch {
    return result
  } finally {
    const [outcome, from] = result.split(' ')
    console.log(
      JSON.stringify({ event: 'runtime_refresh', sandboxId: row.id, outcome, from: from ?? null, to: target, ms: deps.now() - started })
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
    region?: string
    repo?: { url: string; ref?: string }
    /** Boot from exactly this environment build (bld_...). */
    environmentBuildId?: string
    /** Default true: boot from the active build of the org environment that lists the repo. */
    useEnvironment?: boolean
    title?: string
    visibility?: 'private' | 'team'
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
  const source: BootSource | null =
    request.environmentBuildId || request.useEnvironment !== false
      ? await timer.time('environment', () =>
          resolveEnvironmentBoot(deps.db, caller.accountId, {
            repoUrl: request.repo?.url,
            buildId: request.environmentBuildId,
            region: request.region
          })
        )
      : null
  // An automatic environment is only the repo checked out: the caller's machine size stands.
  const machineSize = source && !source.auto ? source.machineSize : request.machineSize
  await timer.time('entitlement', () => requireStart(deps, caller.accountId, caller.userId, machineSize))
  // A snapshot only boots in its own region: an environment build pins the region it was built in.
  const region = source?.region ?? request.region ?? deps.config.defaultRegion
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
        section: request.section ?? null
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
  // The repo is reachable: the next create of it should find it prebuilt (auto-environments.ts).
  if (request.repo && deps.autoEnvironment && !request.environmentBuildId && request.useEnvironment !== false) {
    const work = source?.auto
      ? deps.autoEnvironment.touch(source.environmentId)
      : !source
        ? deps.autoEnvironment.ensure(caller.accountId, request.repo.url)
        : null
    if (work) {
      const settled = work.catch(() => undefined)
      deps.background?.(settled)
    }
  }
  if (pooled) {
    try {
      const state = await timer.time('vm', () =>
        adoptPooledVm(deps, pooled, egressPolicy(deps, routedRow(row, prep), prep.minted?.token, prep.memberPlaceholders))
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
      return cloning ? { ...ready, cloning } : ready
    } catch (error) {
      // A pooled VM that will not take the session is discarded; the caller still gets a workspace.
      console.log(JSON.stringify({ event: 'pool_adopt_failed', error: String(error).slice(0, 200) }))
      await failAndRelease(deps, (await getSandbox(deps.db, row.id)) ?? row, createFailureReason(error))
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
    state = await timer.time('vm', () =>
      deps.provider.createSandbox({
        name: row.provider_name,
        snapshotId: bootSnapshotId,
        vcpus: SANDBOX_VCPUS,
        region: row.region,
        timeoutMs: LEASE_MS,
        ports: [ORCAD_PORT, SHARE_PROXY_PORT],
        networkPolicy: egressPolicy(deps, routedRow(row, prep), prep.minted?.token, prep.memberPlaceholders),
        snapshotExpirationMs: deps.config.snapshotExpirationMs ?? DEFAULT_SNAPSHOT_EXPIRATION_MS,
        tags: { orcaSandbox: row.id, orcaEnv: deps.config.environment }
      })
    )
  } catch (error) {
    await failAndRelease(deps, row, createFailureReason(error))
    // Only a create nothing pinned to a region moves on: no explicit region, no environment build.
    const fallback =
      options.fallback !== false && !request.region && !source && isRegionalFailure(error)
        ? deps.config.fallbackRegions?.find((candidate) => candidate !== region && goldenFor(deps, candidate))
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
    return cloning ? { ...ready, cloning } : ready
  } catch (error) {
    await failAndRelease(deps, (await getSandbox(deps.db, row.id)) ?? row, createFailureReason(error))
    throw error
  }
}

/** last_error for a create that failed with `error`: the step that broke, never a message. */
export function createFailureReason(error: unknown): string {
  if (error instanceof VmCommandError) {
    return error.code
  }
  if (error instanceof LifecycleError) {
    return error.reason ?? error.code
  }
  if (error instanceof ProviderError) {
    return `provider_${error.status}`
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
  return claim(deps, row, { status: 'suspended', ...NO_SESSION })
}

/** The provider ended the session on its own (lease lapsed): bill up to when it stopped. */
export async function markProviderStopped(deps: LifecycleDeps, row: SandboxRow): Promise<SandboxRow> {
  const endedAt = Math.min(deps.now(), row.lease_expires_at ?? deps.now())
  await queueUsage(deps.db, row, endedAt)
  await recordSessionEnd(deps.db, row, endedAt, null, deps.now())
  await deps.hooks?.afterStop?.(row).catch(() => undefined)
  return claim(deps, row, { status: 'suspended', ...NO_SESSION })
}

export async function suspendSandbox(deps: LifecycleDeps, row: SandboxRow): Promise<SandboxRow> {
  // Archived is already stopped (the desktop's Sleep runs after or before an archive).
  if (row.status === 'suspended' || row.status === 'archived') {
    return row
  }
  if (row.status !== 'running') {
    throw new LifecycleError('conflict', `sandbox_${row.status}`)
  }
  const suspending = await claim(deps, row, { status: 'suspending' })
  const suspended = await stopForSuspend(deps, suspending)
  await flushUsage(deps.db, deps.entitlements, deps.now(), row.id)
  return suspended
}

export async function resumeSandbox(deps: LifecycleDeps, row: SandboxRow): Promise<Ready> {
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
  const timer = phaseTimer(deps.now)
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
