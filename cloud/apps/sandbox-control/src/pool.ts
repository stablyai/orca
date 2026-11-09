// Warm pool: a few VMs booted from the current golden image, egress denied, no identity, no orcad.
// A create claims one instead of booting (saves the provider create, ~2 s p50 / ~4 s p95 measured),
// then applies the caller's policy and starts orcad exactly as a fresh VM would. The pooled id becomes
// the sandbox id, so the provider name and ownership tag line up without renaming anything.
// SANDBOX_POOL_SIZE=0 (the default) turns it off; the kill switch drains it.
import type { MachineSize } from './entitlements'
import { killSwitchOn, type GuardrailConfig } from './guardrails'
import type { SandboxProviderApi } from './sandbox-provider'
import { ORCAD_PORT, SHARE_PROXY_PORT } from './sandbox-vm-commands'

export type PoolConfig = {
  /** Ready VMs kept per (machine size, region); only `standard` in the default region is pooled. */
  size: number
  /** Recycle a pooled VM after this long so a claimed session keeps most of its 24 h budget. */
  maxAgeMs: number
}

export const DEFAULT_POOL_MAX_AGE_MS = 20 * 60_000
/** Provider timeout for a pooled VM: outlives max age + one cron period, so the cron deletes it first. */
const POOL_VM_TIMEOUT_MS = DEFAULT_POOL_MAX_AGE_MS + 15 * 60_000
const POOLED_SIZE: MachineSize = 'standard'
/** Ready VMs per hot environment build (its own image: the repo prebuilt, deps installed). */
export const BUILD_POOL_SIZE = 1
/** An environment build is hot while a workspace booted from its environment, or it finished, this recently. */
export const HOT_BUILD_WINDOW_MS = 2 * 60 * 60_000
const MAX_HOT_BUILDS = 20
/** One org with many environments must not take the whole hot-build pool. */
const MAX_HOT_BUILDS_PER_ACCOUNT = 3
/** VMs booted per maintainer pass; the cron finishes the rest (a waitUntil pass has ~30 s). */
const MAX_BOOTS_PER_TICK = 5
const VCPUS: Record<MachineSize, number> = { standard: 4, large: 8 }

export type PoolDeps = {
  db: D1Database
  provider: SandboxProviderApi
  now: () => number
  config: {
    environment: string
    goldenSnapshotId: string
    defaultRegion: string
    guardrails?: GuardrailConfig
    snapshotExpirationMs?: number
    pool?: PoolConfig
  }
}

export type PooledVm = {
  id: string
  provider_name: string
  machine_size: string
  region: string
  snapshot_id: string
  status: 'warming' | 'ready'
  session_id: string | null
  session_started_at: number | null
  session_timeout_ms: number | null
  created_at: number
  updated_at: number
}

export function poolConfigFromEnv(env: { SANDBOX_POOL_SIZE?: string; SANDBOX_POOL_MAX_AGE_MS?: string }): PoolConfig | undefined {
  const size = Number(env.SANDBOX_POOL_SIZE ?? '0')
  if (!Number.isSafeInteger(size) || size <= 0) {
    return undefined
  }
  const maxAge = Number(env.SANDBOX_POOL_MAX_AGE_MS)
  return {
    // A pool is a latency tool, not capacity: keep it small whatever the env says.
    size: Math.min(size, 10),
    maxAgeMs: Number.isSafeInteger(maxAge) && maxAge > 0 && maxAge <= DEFAULT_POOL_MAX_AGE_MS ? maxAge : DEFAULT_POOL_MAX_AGE_MS
  }
}

function poolId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `sbx_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Takes one ready VM for this size/region on the current golden image, or null. One statement, so two
 * creates never get the same VM.
 */
export async function claimPooledVm(
  deps: PoolDeps,
  machineSize: MachineSize,
  region: string,
  /** The image the caller would boot: the golden image, or an environment build's snapshot. */
  snapshotId: string = deps.config.goldenSnapshotId
): Promise<PooledVm | null> {
  const pool = deps.config.pool
  if (!pool || machineSize !== POOLED_SIZE || region !== deps.config.defaultRegion) {
    return null
  }
  return deps.db
    .prepare(
      `DELETE FROM sandbox_pool WHERE id = (
         SELECT id FROM sandbox_pool
          WHERE status = 'ready' AND machine_size = ? AND region = ? AND snapshot_id = ? AND created_at > ?
          ORDER BY created_at LIMIT 1)
       RETURNING *`
    )
    .bind(machineSize, region, snapshotId, deps.now() - pool.maxAgeMs)
    .first<PooledVm>()
}

export type PoolTick = { created: number; recycled: number; ready: number }

/**
 * Cron (and after each claim): delete stale VMs (old, other golden image, stuck warming, or pool off /
 * kill switch on), then boot up to `size` ready VMs.
 */
export async function maintainPool(deps: PoolDeps): Promise<PoolTick | { skipped: 'busy' }> {
  // One maintainer at a time (every create, hit or miss, asks for a refill): a lease row, not a VM.
  if (!(await takeLease(deps))) {
    return { skipped: 'busy' }
  }
  try {
    return await maintain(deps)
  } finally {
    await deps.db.prepare(`DELETE FROM sandbox_pool WHERE id = ?`).bind(LEASE_ID).run()
  }
}

const LEASE_ID = 'pool-maintainer'
const LEASE_MS = 2 * 60_000

async function takeLease(deps: PoolDeps): Promise<boolean> {
  const now = deps.now()
  // A crashed maintainer's lease lapses; status 'lease' is never claimable or counted.
  await deps.db.prepare(`DELETE FROM sandbox_pool WHERE id = ? AND updated_at < ?`).bind(LEASE_ID, now - LEASE_MS).run()
  const taken = await deps.db
    .prepare(
      `INSERT INTO sandbox_pool (id, provider_name, machine_size, region, snapshot_id, status, created_at, updated_at)
       VALUES (?, ?, '', '', '', 'lease', ?, ?) ON CONFLICT (id) DO NOTHING RETURNING id`
    )
    .bind(LEASE_ID, LEASE_ID, now, now)
    .first()
  return taken !== null
}

/**
 * Images worth a warm VM: the golden image (`size`), plus the active build of every environment in
 * use lately (BUILD_POOL_SIZE each), so a create from an org environment skips the provider boot too.
 */
async function poolTargets(deps: PoolDeps, size: number): Promise<Map<string, number>> {
  const targets = new Map<string, number>([[deps.config.goldenSnapshotId, size]])
  const since = deps.now() - HOT_BUILD_WINDOW_MS
  // Hot = a workspace was created from the environment lately (not merely built). Most recent first,
  // so the chosen set is stable tick to tick; capped per account and overall.
  const hot = await deps.db
    .prepare(
      `SELECT b.snapshot_id AS snapshot_id, e.account_id AS account_id,
              (SELECT MAX(s.created_at) FROM sandboxes s WHERE s.environment_id = e.id) AS used_at
         FROM environments e JOIN environment_builds b ON b.id = e.active_build_id
        WHERE e.deleted_at IS NULL AND b.status = 'succeeded' AND b.snapshot_id IS NOT NULL
          AND b.snapshot_deleted_at IS NULL AND json_extract(b.config, '$.machineSize') = ?
          AND used_at > ?
        ORDER BY used_at DESC LIMIT ?`
    )
    .bind(POOLED_SIZE, since, MAX_HOT_BUILDS * 4)
    .all<{ snapshot_id: string; account_id: string }>()
    .catch(() => ({ results: [] as { snapshot_id: string; account_id: string }[] }))
  const perAccount = new Map<string, number>()
  let hotCount = 0
  for (const row of hot.results) {
    const count = perAccount.get(row.account_id) ?? 0
    if (count >= MAX_HOT_BUILDS_PER_ACCOUNT || hotCount >= MAX_HOT_BUILDS || targets.has(row.snapshot_id)) {
      continue
    }
    perAccount.set(row.account_id, count + 1)
    hotCount++
    targets.set(row.snapshot_id, Math.max(targets.get(row.snapshot_id) ?? 0, BUILD_POOL_SIZE))
  }
  return targets
}

async function maintain(deps: PoolDeps): Promise<PoolTick> {
  const now = deps.now()
  const pool = deps.config.pool
  const draining = !pool || (deps.config.guardrails ? await killSwitchOn(deps.db, deps.config.guardrails) : false)
  const all = (await deps.db.prepare(`SELECT * FROM sandbox_pool WHERE status != 'lease'`).all<PooledVm>()).results
  const maxAge = pool?.maxAgeMs ?? DEFAULT_POOL_MAX_AGE_MS
  const targets = draining || !pool ? new Map<string, number>() : await poolTargets(deps, pool.size)
  const expired = (vm: PooledVm) =>
    draining ||
    !targets.has(vm.snapshot_id) ||
    now - vm.created_at > maxAge ||
    (vm.status === 'warming' && now - vm.updated_at > 5 * 60_000)
  // Overlapping ticks can overshoot; the oldest extras go first (per image).
  const keep = all.filter((vm) => !expired(vm)).sort((a, b) => b.created_at - a.created_at)
  const extras: PooledVm[] = []
  const kept = new Map<string, number>()
  for (const vm of keep) {
    const count = (kept.get(vm.snapshot_id) ?? 0) + 1
    kept.set(vm.snapshot_id, count)
    if (count > (targets.get(vm.snapshot_id) ?? 0)) {
      extras.push(vm)
    }
  }
  const stale = [...all.filter(expired), ...extras]
  let recycled = 0
  for (const vm of stale) {
    // Remove the row first: a claim can no longer take it, and a failed delete is retried next tick
    // only if the row is still there, so put it back on failure.
    const removed = await deps.db.prepare('DELETE FROM sandbox_pool WHERE id = ? RETURNING id').bind(vm.id).first()
    if (!removed) {
      continue
    }
    try {
      await deletePooledVm(deps, vm.provider_name, vm.snapshot_id)
      recycled += 1
    } catch (error) {
      await insertRow(deps.db, { ...vm, updated_at: now })
      console.log(JSON.stringify({ event: 'pool_recycle_failed', error: String(error).slice(0, 200) }))
    }
  }
  const live = all.length - recycled
  if (draining || !pool) {
    return { created: 0, recycled, ready: Math.max(0, live) }
  }
  const boots: string[] = []
  for (const [snapshotId, want] of targets) {
    const have = Math.min(kept.get(snapshotId) ?? 0, want)
    for (let i = have; i < want; i++) {
      boots.push(snapshotId)
    }
  }
  if (boots.length === 0) {
    return { created: 0, recycled, ready: Math.max(0, live) }
  }
  const results = await Promise.allSettled(boots.slice(0, MAX_BOOTS_PER_TICK).map((snapshotId) => bootPooledVm(deps, snapshotId)))
  const created = results.filter((r) => r.status === 'fulfilled').length
  for (const failure of results.filter((r) => r.status === 'rejected')) {
    console.log(JSON.stringify({ event: 'pool_boot_failed', error: String(failure.reason).slice(0, 200) }))
  }
  return { created, recycled, ready: live + created }
}

async function bootPooledVm(deps: PoolDeps, snapshotId: string): Promise<void> {
  const id = poolId()
  const now = deps.now()
  const row: PooledVm = {
    id,
    provider_name: `orca-${deps.config.environment}-${id}`,
    machine_size: POOLED_SIZE,
    region: deps.config.defaultRegion,
    snapshot_id: snapshotId,
    status: 'warming',
    session_id: null,
    session_started_at: null,
    session_timeout_ms: null,
    created_at: now,
    updated_at: now
  }
  // Write-ahead: a VM the cron cannot see would never be cleaned up.
  await insertRow(deps.db, row)
  try {
    const state = await deps.provider.createSandbox({
      name: row.provider_name,
      snapshotId: row.snapshot_id,
      vcpus: VCPUS[POOLED_SIZE],
      region: row.region,
      timeoutMs: POOL_VM_TIMEOUT_MS,
      ports: [ORCAD_PORT, SHARE_PROXY_PORT],
      // Nothing leaves a pooled VM until a create gives it the caller's policy.
      networkPolicy: { allow: {} },
      // Short backstop: a pooled VM is deleted running, so it should never leave a snapshot.
      snapshotExpirationMs: 86_400_000,
      tags: { orcaSandbox: id, orcaEnv: deps.config.environment, orcaPool: '1' }
    })
    await deps.db
      .prepare(
        `UPDATE sandbox_pool SET status = 'ready', session_id = ?, session_started_at = ?, session_timeout_ms = ?, updated_at = ?
          WHERE id = ?`
      )
      .bind(state.session.id, state.session.startedAt ?? now, state.session.timeoutMs, deps.now(), id)
      .run()
  } catch (error) {
    await deps.db.prepare('DELETE FROM sandbox_pool WHERE id = ?').bind(id).run()
    await deletePooledVm(deps, row.provider_name, row.snapshot_id).catch(() => undefined)
    throw error
  }
}

/** A pooled VM never ran user code; delete it and any automatic snapshot a provider timeout left. */
export async function deletePooledVm(
  deps: Pick<PoolDeps, 'provider' | 'config'>,
  name: string,
  /** The image it booted from (golden or an environment build) is shared: never deleted here. */
  sourceSnapshotId?: string
): Promise<void> {
  await deps.provider.deleteSandbox(name)
  for (const snapshot of await deps.provider.listSnapshots(name)) {
    if (snapshot.status !== 'deleted' && snapshot.id !== deps.config.goldenSnapshotId && snapshot.id !== sourceSnapshotId) {
      await deps.provider.deleteSnapshot(snapshot.id)
    }
  }
}

async function insertRow(db: D1Database, row: PooledVm): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sandbox_pool (id, provider_name, machine_size, region, snapshot_id, status, session_id,
         session_started_at, session_timeout_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(row.id, row.provider_name, row.machine_size, row.region, row.snapshot_id, row.status, row.session_id,
      row.session_started_at, row.session_timeout_ms, row.created_at, row.updated_at)
    .run()
}
