// Sandbox lifecycle: one persistent provider sandbox per Orca workspace, with an Orca-owned lease,
// a forced stop before the provider's 24h cap, usage metering and write-ahead rows.
import type { EntitlementClient, MachineSize } from './entitlements'
import type { GitHubAppMinter } from './github-app'
import {
  DEFAULT_GUARDRAILS,
  GuardrailError,
  assertAccountCapacity,
  assertStartsOpen,
  killSwitchOn,
  type GuardrailConfig
} from './guardrails'
import { compileNetworkPolicy, gitBasicAuthorization, type CredentialRoute } from './network-policy'
import type { RetentionConfig } from './retention'
import type { ProviderSandboxState, SandboxProviderApi } from './sandbox-provider'
import { applySecretPlaceholders, egressSecretHosts, secretPlaceholder } from './secret-egress'
import { resolveSandboxSecrets } from './secrets'
import type { Keyring } from './secrets-crypto'
import { ORCAD_PORT, drainOrcad, startOrcad, type OrcadReady } from './sandbox-vm-commands'
import {
  NO_SESSION,
  countActiveSandboxes,
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
  secrets?: { keyring: Keyring; egressPlaceholders: boolean }
  now: () => number
  /** Orphan/retention policy for the cron; defaults in retention.ts. */
  retention?: RetentionConfig
  config: {
    environment: string
    goldenSnapshotId: string
    defaultRegion: string
    egressProxyUrl?: string
    /** Staging rehearsals shorten the cap; production uses SESSION_DEADLINE_MS. */
    sessionDeadlineMs?: number
    guardrails?: GuardrailConfig
    snapshotExpirationMs?: number
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

export type Ready = { row: SandboxRow; connection: OrcadReady }

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
              placeholders: [format(secretPlaceholder(row, entry.slug))],
              via: 'forward',
              forwardURL: proxyUrl
            })
          )
        )
      ]
    : []
  return compileNetworkPolicy({ mode: 'allowlist', credentials: [...git, ...credentials] })
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

async function requireStart(deps: LifecycleDeps, accountId: string, machineSize: MachineSize) {
  await assertStartsOpen(deps.db, guardrails(deps))
  const runningSandboxes = await countActiveSandboxes(deps.db, accountId)
  const decision = await deps.entitlements.checkStart({ accountId, machineSize, runningSandboxes })
  if (decision.suspendRunning) {
    await suspendAccountRunning(deps, accountId)
  }
  if (!decision.allow) {
    throw new LifecycleError('entitlement_denied', decision.reason ?? 'denied')
  }
  await assertAccountCapacity(deps.db, guardrails(deps), accountId, decision.seats)
}

async function boot(deps: LifecycleDeps, row: SandboxRow, state: ProviderSandboxState, repo?: { url: string; ref?: string }): Promise<Ready> {
  if (state.sandbox.tags.orcaSandbox !== row.id) {
    throw new LifecycleError('conflict', 'ownership_mismatch')
  }
  const secrets = await sessionSecrets(deps, row)
  const routed: SandboxRow = { ...row, egress_secret_hosts: secrets.hosts.join(',') || null }
  const git = await refreshGitCredentials(deps, routed, state.session.id)
  if (!git && (routed.egress_secret_hosts || row.egress_secret_hosts)) {
    // Model-key routes must be live before any agent starts; the git refresh already wrote them.
    await deps.provider.updateNetworkPolicy(state.session.id, egressPolicy(deps, routed))
  }
  const connection = await startOrcad(deps.provider, state, {
    sandboxId: row.id,
    repo,
    githubPlaceholder: deps.config.egressProxyUrl ? githubPlaceholderToken(row) : undefined,
    gitExtraHeader: git ? `Authorization: ${gitBasicAuthorization(githubPlaceholderToken(row))}` : undefined,
    secretEnv: secrets.env
  })
  const running = await claim(deps, row, {
    status: 'running',
    last_error: null,
    retention_warned_at: null,
    github_token_expires_at: git?.expiresAt ?? null,
    egress_secret_hosts: routed.egress_secret_hosts,
    ...sessionFields(deps, state)
  })
  return { row: running, connection }
}

/**
 * Secrets this session starts with (resolved now, so edits apply on the next start or resume with
 * no image rebuild). With egress placeholders on, model API keys become placeholders.
 */
async function sessionSecrets(deps: LifecycleDeps, row: SandboxRow): Promise<{ env: Record<string, string>; hosts: string[] }> {
  if (!deps.secrets) {
    return { env: {}, hosts: [] }
  }
  const { env, skipped } = await resolveSandboxSecrets(deps.db, deps.secrets.keyring, row)
  // Counts only.
  console.log(JSON.stringify({ event: 'session_secrets', sandboxId: row.id, injected: Object.keys(env).length, skipped }))
  if (!deps.secrets.egressPlaceholders || !deps.config.egressProxyUrl) {
    return { env, hosts: [] }
  }
  return applySecretPlaceholders(row, env)
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
  request: { workspaceId: string; machineSize: MachineSize; region?: string; repo?: { url: string; ref?: string } }
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
    return { row: existing, connection: await startOrcad(deps.provider, state, { sandboxId: existing.id }) }
  }
  await requireStart(deps, caller.accountId, request.machineSize)
  const id = randomId()
  const row = await insertSandbox(
    deps.db,
    {
      id,
      account_id: caller.accountId,
      user_id: caller.userId,
      workspace_id: request.workspaceId,
      provider: 'vercel',
      provider_name: `orca-${deps.config.environment}-${id}`,
      machine_size: request.machineSize,
      region: request.region ?? deps.config.defaultRegion,
      repo_url: request.repo?.url ?? null
    },
    deps.now()
  )
  let state: ProviderSandboxState
  try {
    state = await deps.provider.createSandbox({
      name: row.provider_name,
      snapshotId: deps.config.goldenSnapshotId,
      vcpus: VCPUS[row.machine_size],
      region: row.region,
      timeoutMs: LEASE_MS,
      ports: [ORCAD_PORT],
      networkPolicy: egressPolicy(deps, row),
      snapshotExpirationMs: deps.config.snapshotExpirationMs ?? DEFAULT_SNAPSHOT_EXPIRATION_MS,
      tags: { orcaSandbox: row.id, orcaEnv: deps.config.environment }
    })
  } catch (error) {
    await failAndRelease(deps, row)
    throw error
  }
  try {
    return await boot(deps, row, state, request.repo)
  } catch (error) {
    await failAndRelease(deps, (await getSandbox(deps.db, row.id)) ?? row)
    throw error
  }
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
  return claim(deps, row, { status: 'suspended', ...NO_SESSION })
}

/** The provider ended the session on its own (lease lapsed): bill up to when it stopped. */
export async function markProviderStopped(deps: LifecycleDeps, row: SandboxRow): Promise<SandboxRow> {
  await queueUsage(deps.db, row, Math.min(deps.now(), row.lease_expires_at ?? deps.now()))
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
      return { row, connection: await startOrcad(deps.provider, state, { sandboxId: row.id }) }
    }
    // The provider ended the session (lease lapsed): fall through to a real resume.
    row = await markProviderStopped(deps, row)
  }
  if (row.status !== 'suspended') {
    throw new LifecycleError('conflict', `sandbox_${row.status}`)
  }
  await requireStart(deps, row.account_id, row.machine_size)
  const resuming = await claim(deps, row, { status: 'resuming' })
  return wake(deps, resuming)
}

async function wake(deps: LifecycleDeps, row: SandboxRow): Promise<Ready> {
  const state = await deps.provider.getSandbox(row.provider_name, { resume: true })
  if (!state) {
    await claim(deps, row, { status: 'failed', last_error: 'provider_sandbox_missing' })
    throw new LifecycleError('conflict', 'environment_missing')
  }
  try {
    return await boot(deps, row, state)
  } catch (error) {
    // Leave it resumable: the disk is intact, only this boot failed.
    const current = await getSandbox(deps.db, row.id)
    if (current?.status === 'resuming') {
      await transition(deps.db, current, { status: 'suspended', ...NO_SESSION, last_error: 'resume_failed' }, deps.now())
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
  return destroyed
}
