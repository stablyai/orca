// Workspace lifecycle on top of lifecycle.ts: wake (single-flight, long-poll; every wake source —
// open, message, SSH, preview — goes through it), Restart for unresponsive VMs, archive/unarchive
// with a snapshot TTL, and the status panel's live view (state, metrics, uptime, cost so far).
import type { MachineSize } from './entitlements'
import { GuardrailError, killSwitchOn } from './guardrails'
import {
  DEFAULT_SNAPSHOT_EXPIRATION_MS,
  LifecycleError,
  bootLiveSession,
  claim,
  guardrails,
  markProviderStopped,
  requireStart,
  resumeSandbox,
  stopForSuspend,
  wake,
  type LifecycleDeps,
  type Ready
} from './lifecycle'
import {
  ArchiveMetadataSchema,
  captureArchiveMetadata,
  readVmMetrics,
  type ArchiveMetadata,
  type VmMetrics
} from './sandbox-vm-inspect'
import { NO_SESSION, getSandbox, sandboxUsageMs, transition, type SandboxRow } from './store'
import { flushUsage } from './usage'

const DAY_MS = 86_400_000
export const DEFAULT_ARCHIVE_TTL_MS = 30 * DAY_MS
/** Provider backstop past Orca's own archive TTL, so Orca's cron always deletes first. */
const ARCHIVE_PROVIDER_GRACE_MS = 7 * DAY_MS
export const MAX_WAKE_WAIT_MS = 30_000
const POLL_MS = 400
/** Restart gives a wedged orcad this long to write durable offers before the stop. */
const RESTART_DRAIN_SECONDS = 15
/** A resuming/suspending row older than this is treated as stuck by Restart (the cron's bar is 15 min). */
const RESTART_STUCK_MS = 5 * 60_000
/**
 * A wake whose Worker died (waitUntil cut it off) is picked up by the next wake call after this.
 * Longer than any live inline wake (the desktop's boot timeout is 180 s), so a healthy boot is never taken over.
 */
const WAKE_STALE_MS = 4 * 60_000
/** A wake that just failed answers `failed` for this long instead of booting again on every poll. */
const WAKE_FAILURE_HOLD_MS = 60_000
/** Archive gives orcad this long to write durable offers (the desktop already ran its Sleep). */
const ARCHIVE_DRAIN_SECONDS = 60
export const DEFAULT_CENTS_PER_HOUR: Record<MachineSize, number> = { standard: 75, large: 150 }

export type WorkspaceConfig = {
  archiveTtlMs?: number
  centsPerHour?: Partial<Record<MachineSize, number>>
  /** Keeps a wake running after the response (Worker ctx.waitUntil); tests omit it. */
  background?: (work: Promise<unknown>) => void
  sleep?: (ms: number) => Promise<void>
}

export type WakeState = 'ready' | 'waking' | 'archived' | 'failed' | 'not_found'
export type WakeAnswer = { state: WakeState; endpoint: string | null; readyAt: number | null; sandboxId: string | null }

/** wake/status share one vocabulary with the desktop's host health states. */
export type WorkspaceState =
  | 'provisioning'
  | 'sleeping'
  | 'waking'
  | 'ready'
  | 'unresponsive'
  | 'stopping'
  | 'archived'
  | 'failed'

function wakeAnswer(row: SandboxRow | null): WakeAnswer {
  if (!row || row.status === 'destroyed' || row.status === 'destroying') {
    return { state: 'not_found', endpoint: null, readyAt: null, sandboxId: row?.id ?? null }
  }
  const state: WakeState =
    row.status === 'running'
      ? 'ready'
      : row.status === 'archived'
        ? 'archived'
        : row.status === 'failed'
          ? 'failed'
          : 'waking'
  return {
    state,
    endpoint: state === 'ready' ? row.orcad_endpoint : null,
    readyAt: state === 'ready' ? row.ready_at : null,
    sandboxId: row.id
  }
}

function recentlyFailed(deps: LifecycleDeps, row: SandboxRow): boolean {
  return row.status === 'suspended' && row.last_error === 'resume_failed' && deps.now() - row.updated_at < WAKE_FAILURE_HOLD_MS
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The row says running, but a lapsed lease means the provider may have stopped it on its own. */
async function confirmRunning(deps: LifecycleDeps, row: SandboxRow): Promise<SandboxRow> {
  if (row.lease_expires_at === null || deps.now() < row.lease_expires_at) {
    return row
  }
  const state = await deps.provider.getSandbox(row.provider_name, { resume: false })
  return state?.session.status === 'running' ? row : markProviderStopped(deps, row)
}

/**
 * Idempotent wake. A sleeping workspace starts waking (one wake however many callers race: the
 * `resuming` claim is a compare-and-set); `waitMs` long-polls until ready or the wait runs out.
 * Archived workspaces are not woken implicitly — unarchive is an explicit action.
 */
export async function wakeSandbox(
  deps: LifecycleDeps,
  row: SandboxRow,
  options: { waitMs: number } & WorkspaceConfig
): Promise<WakeAnswer> {
  const waitMs = Math.max(0, Math.min(options.waitMs, MAX_WAKE_WAIT_MS))
  const sleep = options.sleep ?? defaultSleep
  let current = row.status === 'running' ? await confirmRunning(deps, row) : row
  let ours: Promise<unknown> | null = null
  if (current.status === 'running' && !current.orcad_endpoint) {
    // Repaired by the cron after a wake died: the VM runs, orcad may not.
    const state = await deps.provider.getSandbox(current.provider_name, { resume: false })
    current =
      state?.session.status === 'running' ? (await bootLiveSession(deps, current, state)).row : await markProviderStopped(deps, current)
  }
  if (current.status === 'resuming' && deps.now() - current.updated_at >= WAKE_STALE_MS) {
    current = await adoptStaleWake(deps, current)
  }
  if (recentlyFailed(deps, current)) {
    return { state: 'failed', endpoint: null, readyAt: null, sandboxId: current.id }
  }
  if (current.status === 'suspended') {
    await requireStart(deps, current.account_id, current.user_id, current.machine_size)
    const resuming = await transition(deps.db, current, { status: 'resuming' }, deps.now())
    if (resuming) {
      ours = wake(deps, resuming).catch((error: unknown) => {
        console.log(JSON.stringify({ event: 'wake_failed', sandboxId: row.id, error: String(error).slice(0, 120) }))
      })
      options.background?.(ours)
    }
    // Lost the race: someone else's wake is running; fall through and wait on the row.
    current = (await getSandbox(deps.db, row.id)) ?? current
  }
  const deadline = deps.now() + waitMs
  if (ours && waitMs > 0) {
    await Promise.race([ours, sleep(waitMs)])
    current = (await getSandbox(deps.db, row.id)) ?? current
  }
  while (current.status === 'resuming' && deps.now() < deadline) {
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - deps.now())))
    current = (await getSandbox(deps.db, row.id)) ?? current
  }
  if (recentlyFailed(deps, current)) {
    return { state: 'failed', endpoint: null, readyAt: null, sandboxId: current.id }
  }
  return wakeAnswer(current)
}

/**
 * The Worker running a wake was cut off (waitUntil limit) and left the row `resuming`: adopt what
 * the provider says — a running session gets orcad started and becomes `running`; otherwise the
 * row goes back to `suspended` so this wake can start a fresh one.
 */
async function adoptStaleWake(deps: LifecycleDeps, row: SandboxRow): Promise<SandboxRow> {
  const state = await deps.provider.getSandbox(row.provider_name, { resume: false })
  if (state?.session.status !== 'running') {
    return markProviderStopped(deps, row)
  }
  try {
    return (await bootLiveSession(deps, row, state)).row
  } catch (error) {
    if (error instanceof LifecycleError && error.code === 'conflict') {
      // Someone else moved the row meanwhile; report what they left.
      return (await getSandbox(deps.db, row.id)) ?? row
    }
    // Leave it resumable (and reported as failed for a minute) rather than stuck in `resuming`.
    const current = await getSandbox(deps.db, row.id)
    if (current?.status === 'resuming' && current.generation === row.generation) {
      await transition(deps.db, current, { status: 'suspended', ...NO_SESSION, last_error: 'resume_failed' }, deps.now())
    }
    throw error
  }
}

/**
 * "Restart" for an unresponsive workspace: one rehydrate path (short drain, stop with snapshot,
 * boot the same disk). Works from running, sleeping, or a wake/sleep that got stuck mid-way.
 */
export async function restartSandbox(deps: LifecycleDeps, row: SandboxRow): Promise<Ready> {
  if (await killSwitchOn(deps.db, guardrails(deps))) {
    throw new GuardrailError('maintenance')
  }
  let current = row
  if ((current.status === 'resuming' || current.status === 'suspending') && deps.now() - current.updated_at >= RESTART_STUCK_MS) {
    const state = await deps.provider.getSandbox(current.provider_name, { resume: false })
    if (state?.session.status === 'running') {
      await deps.provider.stopSession(state.session.id).catch(() => undefined)
    }
    current = await markProviderStopped(deps, current)
  }
  if (current.status === 'running') {
    // A lapsed lease means the provider already stopped it; resume instead of stopping a dead session.
    current = await confirmRunning(deps, current)
  }
  if (current.status === 'suspended') {
    return resumeSandbox(deps, current)
  }
  if (current.status !== 'running') {
    throw new LifecycleError('conflict', `sandbox_${current.status}`)
  }
  const suspending = await claim(deps, current, { status: 'suspending' })
  const stopped = await stopForSuspend(deps, suspending, { drainSeconds: RESTART_DRAIN_SECONDS })
  await flushUsage(deps.db, deps.entitlements, deps.now(), row.id)
  return wake(deps, await claim(deps, stopped, { status: 'resuming' }))
}

export async function readArchive(db: D1Database, sandboxId: string): Promise<{ capturedAt: number; source: string; metadata: ArchiveMetadata } | null> {
  const stored = await db
    .prepare('SELECT captured_at, source, metadata FROM sandbox_archives WHERE sandbox_id = ?')
    .bind(sandboxId)
    .first<{ captured_at: number; source: string; metadata: string }>()
  if (!stored) {
    return null
  }
  const parsed = ArchiveMetadataSchema.safeParse(JSON.parse(stored.metadata))
  return parsed.success ? { capturedAt: stored.captured_at, source: stored.source, metadata: parsed.data } : null
}

async function writeArchive(db: D1Database, sandboxId: string, source: string, metadata: ArchiveMetadata, now: number) {
  await db
    .prepare(
      `INSERT INTO sandbox_archives (sandbox_id, captured_at, source, metadata) VALUES (?, ?, ?, ?)
       ON CONFLICT (sandbox_id) DO UPDATE SET captured_at = excluded.captured_at, source = excluded.source, metadata = excluded.metadata`
    )
    .bind(sandboxId, now, source, JSON.stringify(metadata))
    .run()
}

export async function deleteArchive(db: D1Database, sandboxId: string): Promise<void> {
  await db.prepare('DELETE FROM sandbox_archives WHERE sandbox_id = ?').bind(sandboxId).run()
}

/**
 * Archive = stop and keep the snapshot for a TTL. Git metadata is captured in the VM when it is
 * running; a sleeping VM is not woken just to archive it — the desktop's cached git state is used.
 */
export async function archiveSandbox(
  deps: LifecycleDeps,
  input: SandboxRow,
  request: Partial<ArchiveMetadata>,
  config: WorkspaceConfig = {}
): Promise<SandboxRow> {
  let row = input
  if (row.status === 'archived') {
    return row
  }
  if (row.status !== 'running' && row.status !== 'suspended') {
    throw new LifecycleError('conflict', `sandbox_${row.status}`)
  }
  const captured = row.status === 'running' && row.session_id ? await captureArchiveMetadata(deps.provider, row.session_id) : null
  // The capture takes seconds; a lease renew may have moved the row meanwhile.
  row = (await getSandbox(deps.db, row.id)) ?? row
  if (row.status !== 'running' && row.status !== 'suspended') {
    throw new LifecycleError('conflict', `sandbox_${row.status}`)
  }
  const previous = await readArchive(deps.db, row.id)
  const checkouts = captured?.checkouts ?? request.checkouts ?? previous?.metadata.checkouts ?? []
  const source = captured ? 'vm' : request.checkouts ? 'client' : previous ? previous.source : 'none'
  await writeArchive(
    deps.db,
    row.id,
    source,
    { checkouts, pullRequests: request.pullRequests ?? previous?.metadata.pullRequests ?? [] },
    deps.now()
  )
  let stopped = row
  if (row.status === 'running') {
    // Short drain: the desktop's Sleep normally ran first; a long drain would outlive the caller.
    stopped = await stopForSuspend(deps, await claim(deps, row, { status: 'suspending' }), { drainSeconds: ARCHIVE_DRAIN_SECONDS })
    await flushUsage(deps.db, deps.entitlements, deps.now(), row.id)
  }
  const ttl = config.archiveTtlMs ?? DEFAULT_ARCHIVE_TTL_MS
  await deps.provider
    .updateSnapshotExpiration(stopped.provider_name, ttl + ARCHIVE_PROVIDER_GRACE_MS)
    .catch((error: unknown) => console.log(JSON.stringify({ event: 'archive_ttl_update_failed', sandboxId: row.id, error: String(error).slice(0, 120) })))
  return claim(deps, stopped, {
    status: 'archived',
    ...NO_SESSION,
    archived_at: deps.now(),
    archive_expires_at: deps.now() + ttl
  })
}

/** Unarchive restores the long-lived snapshot backstop and resumes the same disk. */
export async function unarchiveSandbox(deps: LifecycleDeps, row: SandboxRow): Promise<Ready> {
  if (row.status !== 'archived') {
    if (row.status === 'running' || row.status === 'suspended') {
      return resumeSandbox(deps, row)
    }
    throw new LifecycleError('conflict', `sandbox_${row.status}`)
  }
  await requireStart(deps, row.account_id, row.user_id, row.machine_size)
  await deps.provider.updateSnapshotExpiration(
    row.provider_name,
    deps.config.snapshotExpirationMs ?? DEFAULT_SNAPSHOT_EXPIRATION_MS
  )
  const suspended = await claim(deps, row, { status: 'suspended', archived_at: null, archive_expires_at: null })
  return resumeSandbox(deps, suspended)
}

/** Cron: archives past their TTL are destroyed (snapshots included). */
export async function expiredArchives(db: D1Database, now: number): Promise<SandboxRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM sandboxes WHERE status = 'archived' AND archive_expires_at <= ? ORDER BY archive_expires_at LIMIT 50`)
    .bind(now)
    .all<SandboxRow>()
  return results
}

export type WorkspaceStatus = {
  state: WorkspaceState
  metrics: VmMetrics | null
  /** Since orcad last became ready (this session). */
  uptimeMs: number | null
  usage: { totalMs: number; centsPerHour: number; costCents: number }
  archive: { archivedAt: number; expiresAt: number | null } | null
  checkedAt: number
}

function stateOf(row: SandboxRow, metrics: VmMetrics | null, probed: boolean): WorkspaceState {
  switch (row.status) {
    case 'creating':
      return 'provisioning'
    case 'resuming':
      return 'waking'
    case 'suspending':
    case 'destroying':
      return 'stopping'
    case 'suspended':
      return 'sleeping'
    case 'archived':
      return 'archived'
    case 'running':
      return probed && (!metrics || !metrics.orcadAlive) ? 'unresponsive' : 'ready'
    default:
      return 'failed'
  }
}

/** The status panel's one call. Metrics are read live from the VM only when it is running. */
export async function workspaceStatus(deps: LifecycleDeps, input: SandboxRow, config: WorkspaceConfig = {}): Promise<WorkspaceStatus> {
  // A lapsed lease: the provider may have stopped it, which is "sleeping", not "unresponsive".
  const row = input.status === 'running' ? await confirmRunning(deps, input) : input
  const probed = row.status === 'running' && row.session_id !== null
  const metrics = probed ? await readVmMetrics(deps.provider, row.session_id!) : null
  const now = deps.now()
  const totalMs = await sandboxUsageMs(deps.db, row, now)
  const centsPerHour = config.centsPerHour?.[row.machine_size] ?? DEFAULT_CENTS_PER_HOUR[row.machine_size]
  return {
    state: stateOf(row, metrics, probed),
    metrics,
    uptimeMs: row.status === 'running' && row.ready_at !== null ? Math.max(0, now - row.ready_at) : null,
    usage: { totalMs, centsPerHour, costCents: Math.round((totalMs / 3_600_000) * centsPerHour) },
    archive: row.archived_at !== null ? { archivedAt: row.archived_at, expiresAt: row.archive_expires_at } : null,
    checkedAt: now
  }
}

export { getSandbox }
