// Sandbox lifecycle: one persistent provider sandbox per Orca workspace, with an Orca-owned lease,
// a forced stop before the provider's 24h cap, usage metering and write-ahead rows.
import type { EntitlementClient, MachineSize } from './entitlements'
import { compileNetworkPolicy, type CredentialRoute } from './network-policy'
import type { ProviderSandboxState, SandboxProviderApi } from './sandbox-provider'
import { ORCAD_PORT, drainOrcad, startOrcad, type OrcadReady } from './sandbox-vm-commands'
import {
  NO_SESSION,
  countActiveSandboxes,
  getSandbox,
  insertSandbox,
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
const VCPUS: Record<MachineSize, number> = { standard: 4, large: 8, xlarge: 16 }

export type LifecycleDeps = {
  db: D1Database
  provider: SandboxProviderApi
  entitlements: EntitlementClient
  now: () => number
  config: {
    environment: string
    goldenSnapshotId: string
    defaultRegion: string
    egressProxyUrl?: string
    /** Staging rehearsals shorten the cap; production uses SESSION_DEADLINE_MS. */
    sessionDeadlineMs?: number
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

function egressPolicy(deps: LifecycleDeps, row: SandboxRow) {
  const credentials: CredentialRoute[] = deps.config.egressProxyUrl
    ? [
        {
          host: 'api.github.com',
          header: 'authorization',
          placeholders: githubPlaceholderHeaders(row),
          via: 'forward',
          forwardURL: deps.config.egressProxyUrl
        }
      ]
    : []
  return compileNetworkPolicy({ mode: 'allowlist', credentials })
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

async function requireStart(deps: LifecycleDeps, accountId: string, machineSize: MachineSize) {
  const runningSandboxes = await countActiveSandboxes(deps.db, accountId)
  const decision = await deps.entitlements.checkStart({ accountId, machineSize, runningSandboxes })
  if (!decision.allow) {
    throw new LifecycleError('entitlement_denied', decision.reason ?? 'denied')
  }
}

async function boot(deps: LifecycleDeps, row: SandboxRow, state: ProviderSandboxState, repo?: { url: string; ref?: string }): Promise<Ready> {
  if (state.sandbox.tags.orcaSandbox !== row.id) {
    throw new LifecycleError('conflict', 'ownership_mismatch')
  }
  const connection = await startOrcad(deps.provider, state, {
    sandboxId: row.id,
    repo,
    githubPlaceholder: deps.config.egressProxyUrl ? githubPlaceholderToken(row) : undefined
  })
  const running = await claim(deps, row, { status: 'running', last_error: null, ...sessionFields(deps, state) })
  return { row: running, connection }
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
      region: request.region ?? deps.config.defaultRegion
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
  const destroyed = await claim(deps, destroying, { status: 'destroyed', ...NO_SESSION, destroyed_at: deps.now() })
  await flushUsage(deps.db, deps.entitlements, deps.now(), row.id)
  return destroyed
}
