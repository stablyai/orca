// Sandbox lifecycle: one persistent provider sandbox per Orca workspace, with an Orca-owned lease,
// a forced stop before the provider's 24h cap, usage metering and write-ahead rows.
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
import { DEFAULT_EGRESS_ALLOWLIST, compileNetworkPolicy, gitBasicAuthorization, type CredentialRoute } from './network-policy'
import type { RetentionConfig } from './retention'
import type { ProviderSandboxState, SandboxProviderApi } from './sandbox-provider'
import { egressSecretHosts, secretPlaceholder } from './secret-egress'
import { egressAllowHosts, sessionSecretEnv, type SessionSecrets } from './session-env'
import type { Keyring } from './secrets-crypto'
import { ORCAD_PORT, drainOrcad, runningOrcad, startOrcad, type OrcadReady } from './sandbox-vm-commands'
import { claimPooledVm, deletePooledVm, maintainPool, type PoolConfig, type PooledVm } from './pool'
import {
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
import { flushUsage, queueUsage } from './usage'

export const LEASE_MS = 30 * 60_000
const PROVIDER_SESSION_CAP_MS = 24 * 60 * 60_000
/** Orca stops 10 min early so it, not the provider, ends the session (drain first). */
export const SESSION_DEADLINE_MS = PROVIDER_SESSION_CAP_MS - 10 * 60_000
const VCPUS: Record<MachineSize, number> = { standard: 4, large: 8 }
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
  /** egressPlaceholders: every account (`true`) or only the listed account ids (staged rollout). */
  secrets?: { keyring: Keyring; egressPlaceholders: boolean | ReadonlySet<string> }
  now: () => number
  /** Orphan/retention policy for the cron; defaults in retention.ts. */
  retention?: RetentionConfig
  /**
   * Whether a github.com repo clones anonymously (public). Asked only when no App token covers it, so a
   * private repo without a connected GitHub fails fast with `github_not_connected` instead of a clone
   * error after boot. Absent: no check.
   */
  publicRepoCheck?: (repoUrl: string) => Promise<boolean>
  /** Work that may finish after the response (Worker ctx.waitUntil); absent means fire-and-forget. */
  background?: (work: Promise<unknown>) => void
  /** Best-effort side effects of a session starting or ending (workspace tokens, see api/settings.ts). */
  hooks?: {
    afterBoot?(row: SandboxRow, sessionId: string): Promise<unknown>
    afterStop?(row: SandboxRow): Promise<unknown>
  }
  config: {
    environment: string
    goldenSnapshotId: string
    defaultRegion: string
    egressProxyUrl?: string
    /** Staging rehearsals shorten the cap; production uses SESSION_DEADLINE_MS. */
    sessionDeadlineMs?: number
    guardrails?: GuardrailConfig
    snapshotExpirationMs?: number
    /** Warm pool (pool.ts); absent or size 0 means every create boots its own VM. */
    pool?: PoolConfig
    /** Hosts allowed on top of the default egress allowlist (e.g. this control plane for the in-VM CLI). */
    extraEgressHosts?: readonly string[]
  }
}

export class LifecycleError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'entitlement_denied' | 'provider_unavailable',
    readonly reason?: string
  ) {
    super(reason ? `${code}:${reason}` : code)
    this.name = 'LifecycleError'
  }
}

export type Ready = { row: SandboxRow; connection: OrcadReady; timings?: Record<string, number> }

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
}

/** Everything a boot needs that does not depend on the VM: resolved concurrently with the VM work. */
async function prepareBoot(deps: LifecycleDeps, row: SandboxRow): Promise<BootPrep> {
  const [secrets, minted] = await Promise.all([
    sessionSecretEnv(deps, row),
    deps.github && row.repo_url ? deps.github.tokenForRepo(row.repo_url, row.account_id) : Promise.resolve(null)
  ])
  return { secrets, minted }
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

export function egressPolicy(deps: LifecycleDeps, row: SandboxRow, gitToken?: string) {
  const git: CredentialRoute[] = gitToken
    ? [
        {
          // git (libcurl) is unaffected by the transform-rule framing hang, so it is injected inline.
          host: 'github.com',
          header: 'authorization',
          placeholders: [gitBasicAuthorization(githubPlaceholderToken(row))],
          via: 'transform',
          value: gitBasicAuthorization(gitToken)
        }
      ]
    : []
  const proxyUrl = deps.config.egressProxyUrl
  const credentials: CredentialRoute[] = proxyUrl
    ? [
        {
          host: 'api.github.com',
          header: 'authorization',
          placeholders: githubPlaceholderHeaders(row),
          via: 'forward',
          forwardURL: proxyUrl
        },
        // Model API keys swapped at egress (phase 2); each host also ends in the 403 deny rule.
        ...egressSecretHosts(row).flatMap((entry) =>
          Object.entries(entry.headers).map(
            ([header, format]): CredentialRoute => ({
              host: entry.host,
              header,
              placeholders: [format(secretPlaceholder(row, entry.secret))],
              via: 'forward',
              forwardURL: proxyUrl
            })
          )
        )
      ]
    : []
  // Custom model-provider hosts (ANTHROPIC_BASE_URL / OPENAI_BASE_URL secrets) recorded at boot,
  // plus operator-configured extra hosts.
  const allowlist = [...new Set([...DEFAULT_EGRESS_ALLOWLIST, ...(deps.config.extraEgressHosts ?? []), ...egressAllowHosts(row)])]
  return compileNetworkPolicy({ mode: 'allowlist', allowlist, credentials: [...git, ...credentials] })
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

async function claim(deps: LifecycleDeps, row: SandboxRow, patch: Partial<SandboxRow>): Promise<SandboxRow> {
  const next = await transition(deps.db, row, patch, deps.now())
  if (!next) {
    throw new LifecycleError('conflict', 'concurrent_transition')
  }
  return next
}

export function guardrails(deps: LifecycleDeps): GuardrailConfig {
  return deps.config.guardrails ?? DEFAULT_GUARDRAILS
}

async function requireStart(deps: LifecycleDeps, accountId: string, userId: string, machineSize: MachineSize) {
  const [, runningSandboxes, runningSandboxesForUser] = await Promise.all([
    assertStartsOpen(deps.db, guardrails(deps)),
    countActiveSandboxes(deps.db, accountId),
    countActiveSandboxesForUser(deps.db, accountId, userId)
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
  await assertAccountCapacity(deps.db, guardrails(deps), accountId, {
    seats: decision.seats,
    maxConcurrentSandboxes: decision.maxConcurrentSandboxes
  })
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
  }
): Promise<Ready> {
  if (state.sandbox.tags.orcaSandbox !== row.id) {
    throw new LifecycleError('conflict', 'ownership_mismatch')
  }
  const routed = routedRow(row, prep)
  const git = prep.minted ? { expiresAt: prep.minted.expiresAt } : null
  // A resumed session keeps its last policy (an expired repo token); swap it in while orcad boots.
  // Nothing in the VM uses git or model keys before orcad answers and the desktop attaches.
  const needsPolicy =
    !options.policyApplied &&
    (git || routed.egress_secret_hosts || row.egress_secret_hosts || routed.egress_allow_hosts || row.egress_allow_hosts)
  const [, connection] = await Promise.all([
    needsPolicy
      ? options.timer.time('policy', () =>
          deps.provider.updateNetworkPolicy(state.session.id, egressPolicy(deps, routed, prep.minted?.token))
        )
      : Promise.resolve(),
    options.timer.time('orcad', () =>
      startOrcad(deps.provider, state, {
        sandboxId: row.id,
        repo: options.repo,
        // Repos hosted outside github.com get no GitHub credential, not even the placeholder.
        githubPlaceholder: deps.config.egressProxyUrl && parseGitHubRepo(row.repo_url ?? '') ? githubPlaceholderToken(row) : undefined,
        gitExtraHeader: git ? `Authorization: ${gitBasicAuthorization(githubPlaceholderToken(row))}` : undefined,
        secretEnv: prep.secrets.env
      })
    )
  ])
  const running = await claim(deps, row, {
    status: 'running',
    last_error: null,
    retention_warned_at: null,
    github_token_expires_at: git?.expiresAt ?? null,
    egress_secret_hosts: routed.egress_secret_hosts,
    egress_allow_hosts: routed.egress_allow_hosts,
    ...sessionFields(deps, state),
    ...(options.billFrom !== undefined ? { usage_settled_at: options.billFrom } : {})
  })
  await deps.hooks?.afterBoot?.(running, state.session.id).catch(() => undefined)
  return { row: running, connection, timings: options.timer.timings }
}

/** Mints a fresh repo token and swaps it into the live policy; null when the repo has no app install. */
export async function refreshGitCredentials(
  deps: LifecycleDeps,
  row: SandboxRow,
  sessionId: string
): Promise<{ expiresAt: number } | null> {
  if (!deps.github || !row.repo_url) {
    return null
  }
  const minted = await deps.github.tokenForRepo(row.repo_url, row.account_id)
  if (!minted) {
    return null
  }
  await deps.provider.updateNetworkPolicy(sessionId, egressPolicy(deps, row, minted.token))
  return { expiresAt: minted.expiresAt }
}

export async function createSandbox(
  deps: LifecycleDeps,
  caller: { accountId: string; userId: string },
  request: { workspaceId: string; machineSize: MachineSize; region?: string; repo?: { url: string; ref?: string } },
  options: { pool?: boolean } = {}
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
  await timer.time('entitlement', () => requireStart(deps, caller.accountId, caller.userId, request.machineSize))
  const region = request.region ?? deps.config.defaultRegion
  const pooled =
    options.pool === false
      ? null
      : await timer.time('pool', () => claimPooledVm(deps, request.machineSize, region).catch(() => null))
  if (pooled) {
    // Refill behind the response so the next create finds one too.
    const refill = maintainPool(deps).catch((error: unknown) =>
      console.log(JSON.stringify({ event: 'pool_refill_failed', error: String(error).slice(0, 200) }))
    )
    deps.background?.(refill)
  }
  const claimedAt = deps.now()
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
        machine_size: request.machineSize,
        region,
        repo_url: request.repo?.url ?? null
      },
      deps.now()
    ).catch(async (error: unknown) => {
      if (pooled) {
        await deletePooledVm(deps, pooled.provider_name).catch(() => undefined)
      }
      throw error
    })
    try {
      const prepared = await prepareBoot(deps, inserted)
      await assertRepoReachable(deps, inserted, prepared)
      return [inserted, prepared] as const
    } catch (error) {
      // Nothing booted for this row yet (a pooled VM goes with it): fail it before any VM work.
      await failAndRelease(deps, inserted)
      throw error
    }
  })
  if (pooled) {
    try {
      const state = await timer.time('vm', () =>
        adoptPooledVm(deps, pooled, egressPolicy(deps, routedRow(row, prep), prep.minted?.token))
      )
      const ready = await boot(deps, row, state, prep, { repo: request.repo, policyApplied: true, timer, billFrom: claimedAt })
      console.log(JSON.stringify({ event: 'lifecycle_timing', op: 'create', pooled: true, ms: timer.timings }))
      return ready
    } catch (error) {
      // A pooled VM that will not take the session is discarded; the caller still gets a workspace.
      console.log(JSON.stringify({ event: 'pool_adopt_failed', error: String(error).slice(0, 200) }))
      await failAndRelease(deps, (await getSandbox(deps.db, row.id)) ?? row)
      return createSandbox(deps, caller, request, { pool: false })
    }
  }
  let state: ProviderSandboxState
  try {
    // The full policy (repo token, model-key routes) goes in at create: no second policy round trip.
    state = await timer.time('vm', () =>
      deps.provider.createSandbox({
        name: row.provider_name,
        snapshotId: deps.config.goldenSnapshotId,
        vcpus: VCPUS[row.machine_size],
        region: row.region,
        timeoutMs: LEASE_MS,
        ports: [ORCAD_PORT],
        networkPolicy: egressPolicy(deps, routedRow(row, prep), prep.minted?.token),
        snapshotExpirationMs: deps.config.snapshotExpirationMs ?? DEFAULT_SNAPSHOT_EXPIRATION_MS,
        tags: { orcaSandbox: row.id, orcaEnv: deps.config.environment }
      })
    )
  } catch (error) {
    await failAndRelease(deps, row)
    throw error
  }
  try {
    const ready = await boot(deps, row, state, prep, { repo: request.repo, policyApplied: true, timer })
    console.log(JSON.stringify({ event: 'lifecycle_timing', op: 'create', ms: timer.timings }))
    return ready
  } catch (error) {
    await failAndRelease(deps, (await getSandbox(deps.db, row.id)) ?? row)
    throw error
  }
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

/** A create that never became usable is destroyed now; the cron retries if this also fails. */
export async function failAndRelease(deps: LifecycleDeps, row: SandboxRow): Promise<void> {
  const failed = await transition(deps.db, row, { status: 'failed', last_error: 'create_failed' }, deps.now())
  if (failed) {
    await destroySandbox(deps, failed).catch(() => undefined)
  }
}

async function stopForSuspend(deps: LifecycleDeps, row: SandboxRow): Promise<SandboxRow> {
  if (row.session_id) {
    await drainOrcad(deps.provider, row.session_id)
    const stopped = await deps.provider.stopSession(row.session_id)
    if (stopped.snapshotId) {
      await recordSnapshots(deps.db, row.id, [stopped.snapshotId], deps.now())
    }
  }
  await queueUsage(deps.db, row, deps.now())
  await deps.hooks?.afterStop?.(row).catch(() => undefined)
  return claim(deps, row, { status: 'suspended', ...NO_SESSION })
}

/** The provider ended the session on its own (lease lapsed): bill up to when it stopped. */
export async function markProviderStopped(deps: LifecycleDeps, row: SandboxRow): Promise<SandboxRow> {
  await queueUsage(deps.db, row, Math.min(deps.now(), row.lease_expires_at ?? deps.now()))
  await deps.hooks?.afterStop?.(row).catch(() => undefined)
  return claim(deps, row, { status: 'suspended', ...NO_SESSION })
}

export async function suspendSandbox(deps: LifecycleDeps, row: SandboxRow): Promise<SandboxRow> {
  if (row.status === 'suspended') {
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
  if (row.status === 'running') {
    const state = await deps.provider.getSandbox(row.provider_name, { resume: false })
    if (state?.session.status === 'running') {
      // Idempotent: a running, serving sandbox answers at once (desktop wake-on-open after a restart).
      const connection =
        (await runningOrcad(deps.provider, state.session.id)) ??
        (await startOrcad(deps.provider, state, { sandboxId: row.id }))
      return { row, connection }
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

async function wake(deps: LifecycleDeps, row: SandboxRow): Promise<Ready> {
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
    if (current?.status === 'resuming') {
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
  const stopped = await stopForSuspend(deps, suspending)
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
  if (settled !== destroying.usage_settled_at) {
    destroying = await claim(deps, destroying, { usage_settled_at: settled })
  }
  await deps.provider.deleteSandbox(destroying.provider_name)
  // Persistent sandboxes leave automatic snapshots behind delete; prove none survive.
  const listed = await deps.provider.listSnapshots(destroying.provider_name)
  await recordSnapshots(deps.db, row.id, listed.map((s) => s.id), deps.now())
  for (const id of await recordedSnapshotIds(deps.db, row.id)) {
    if (id !== deps.config.goldenSnapshotId) {
      await deps.provider.deleteSnapshot(id)
    }
  }
  const remaining = (await deps.provider.listSnapshots(destroying.provider_name)).filter(
    (s) => s.status !== 'deleted' && s.id !== deps.config.goldenSnapshotId
  )
  if (remaining.length > 0) {
    throw new LifecycleError('provider_unavailable', 'snapshot_cleanup_incomplete')
  }
  await markSnapshotsDeleted(deps.db, row.id, deps.now())
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
