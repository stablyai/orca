// Org environment snapshots are built on top of a golden image, so a workspace booted from one keeps
// that golden's orcad and VM scripts. After every golden swap this rebuilds, in the background, each
// environment whose active build came from an older golden:
// - same config as the active build (only the base image changes), billed like any build;
// - the active build keeps serving until the new one succeeds, then the normal newest-success
//   activation swaps it in atomically; the old snapshot stays as a rollback (pruneSnapshots keeps it);
// - a failed rebuild leaves the active build in place and shows the usual "update failed" state, and is
//   not retried for the same golden (the attempt is recorded by its base_snapshot_id);
// - rate-limited: a few starts per tick and a cap on builds in flight across all accounts.
// ENV-BUILD-CHURN: goldens rotate per merge that touches the VM (every ~15 min on dev), so rebuilding
// every environment on every rotation cost each team build hours for our image updates. Now:
// - eager only for environments used in the last `recentMs` (7 d; never recorded counts as used), and
//   at most once per `minIntervalMs` (24 h; 6 h on dev), always to the newest golden;
// - the rest refresh lazily when a create next boots from them (refreshEnvironment, behind the create);
// - an environment below the security floor (environment-security.ts) is rebuilt regardless;
// - refresh builds are metered internally, never charged to the team (reportBuildUsage).
// Staleness is exact: environment_builds.base_snapshot_id is the golden snapshot each build started from.
// Regions (U17): an environment lives in the default region, so a build is compared with the default
// region's golden. An older build from another region (iad1 before pdx1 became the default) is stale
// by that rule and is rebuilt in the default region; its workspaces boot in the build's own region
// until the new build is active.
import type { SandboxCaller } from './auth'
import {
  GOLDEN_REFRESH_USER,
  parseConfig,
  startBuild,
  type BuildConfig,
  type BuildDeps,
  type BuildRow
} from './environment-builds'
import { buildSecurityLevel, securityFloor } from './environment-security'
import type { EnvironmentRow } from './environments'

export { GOLDEN_REFRESH_USER }

export type GoldenRefreshTick = { stale: number; started: number; skipped: number; deferred: number }

export type GoldenRefreshOptions = {
  maxStartsPerTick?: number
  maxInFlight?: number
  /** A non-security refresh of the same environment at most this often (env ENV_REFRESH_MIN_INTERVAL_HOURS). */
  minIntervalMs?: number
  /** Eager only for environments used this recently; the rest wait for their next create. */
  recentMs?: number
}

export const DEFAULT_REFRESH_MIN_INTERVAL_MS = 24 * 60 * 60_000
export const DEFAULT_REFRESH_RECENT_MS = 7 * 24 * 60 * 60_000

type StaleRow = EnvironmentRow & {
  active_config: BuildRow['config']
  active_base: string | null
  active_created_at: number
}

const STALE_SQL = `SELECT e.*, b.config AS active_config, b.base_snapshot_id AS active_base, b.created_at AS active_created_at
   FROM environments e JOIN environment_builds b ON b.id = e.active_build_id
  WHERE e.deleted_at IS NULL AND b.base_snapshot_id != ?
    AND NOT EXISTS (
      SELECT 1 FROM environment_builds x WHERE x.environment_id = e.id
         AND (x.status IN ('starting', 'running', 'snapshotting')
              OR (x.base_snapshot_id = ? AND x.status != 'canceled')))`

/** Why a stale environment rebuilds now ('security' | 'due'), or null to wait. */
async function refreshReason(
  deps: BuildDeps,
  environment: StaleRow,
  floor: number,
  options: { minIntervalMs: number; recentMs?: number }
): Promise<'security' | 'due' | null> {
  if (floor > 0 && (await buildSecurityLevel(deps.db, environment.active_base)) < floor) {
    return 'security'
  }
  const now = deps.now()
  if (options.recentMs !== undefined) {
    const lastUsed = environment.last_used_at ?? null
    // Never recorded (an org environment from before use was tracked): counted as used.
    if (lastUsed !== null && now - lastUsed > options.recentMs) {
      return null
    }
  }
  return now - environment.active_created_at >= options.minIntervalMs ? 'due' : null
}

async function startRefresh(deps: BuildDeps, environment: StaleRow, reason: string): Promise<BuildRow> {
  // An org-less account is its own admin; the build is attributed to the system (metered, not charged).
  const caller: SandboxCaller = { userId: GOLDEN_REFRESH_USER, accountId: environment.account_id }
  const config: BuildConfig = parseConfig({ config: environment.active_config })
  const build = await startBuild(deps, caller, environment, { config })
  console.log(JSON.stringify({ event: 'environment_golden_refresh_started', environmentId: environment.id, buildId: build.id, reason }))
  return build
}

export async function refreshStaleEnvironments(
  deps: BuildDeps,
  options: GoldenRefreshOptions = {}
): Promise<GoldenRefreshTick> {
  const golden = deps.config.goldenSnapshotId
  const maxStarts = options.maxStartsPerTick ?? 2
  const maxInFlight = options.maxInFlight ?? 3
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_REFRESH_MIN_INTERVAL_MS
  const recentMs = options.recentMs ?? DEFAULT_REFRESH_RECENT_MS
  const { results: stale } = await deps.db.prepare(`${STALE_SQL} ORDER BY e.updated_at DESC`).bind(golden, golden).all<StaleRow>()
  const floor = await securityFloor(deps.db, deps.config.region)
  const inFlight =
    (await deps.db
      .prepare(`SELECT count(*) AS n FROM environment_builds WHERE status IN ('starting', 'running', 'snapshotting')`)
      .first<{ n: number }>())?.n ?? 0
  // Security rebuilds go first.
  const ranked: { environment: StaleRow; reason: 'security' | 'due' }[] = []
  let deferred = 0
  for (const environment of stale) {
    const reason = await refreshReason(deps, environment, floor, { minIntervalMs, recentMs })
    if (reason) {
      ranked.push({ environment, reason })
    } else {
      deferred++
    }
  }
  ranked.sort((a, b) => (a.reason === b.reason ? 0 : a.reason === 'security' ? -1 : 1))
  let started = 0
  let skipped = 0
  for (const { environment, reason } of ranked) {
    if (started >= maxStarts || inFlight + started >= maxInFlight) {
      break
    }
    try {
      await startRefresh(deps, environment, reason)
      started++
    } catch (error) {
      // Entitlement denied, kill switch, a racing manual build: try again on a later golden or tick.
      skipped++
      console.log(JSON.stringify({ event: 'environment_golden_refresh_skipped', environmentId: environment.id, error: String(error).slice(0, 160) }))
    }
  }
  return { stale: stale.length, started, skipped, deferred }
}

/**
 * A create just booted from this environment (or was kept off it by the security floor): rebuild it on
 * the current golden if it is stale and due, or below the floor. Never throws; at most one build, since
 * an environment with one in flight (or already on this golden) is not stale.
 */
export async function refreshEnvironment(
  deps: BuildDeps,
  environmentId: string,
  options: Pick<GoldenRefreshOptions, 'minIntervalMs'> = {}
): Promise<'started' | 'current' | 'deferred' | 'skipped'> {
  try {
    const golden = deps.config.goldenSnapshotId
    const environment = await deps.db
      .prepare(`${STALE_SQL} AND e.id = ?`)
      .bind(golden, golden, environmentId)
      .first<StaleRow>()
    if (!environment) {
      return 'current'
    }
    const floor = await securityFloor(deps.db, deps.config.region)
    // Used right now, so no recency test: only the interval (or the floor) decides.
    const reason = await refreshReason(deps, environment, floor, {
      minIntervalMs: options.minIntervalMs ?? DEFAULT_REFRESH_MIN_INTERVAL_MS
    })
    if (!reason) {
      return 'deferred'
    }
    await startRefresh(deps, environment, `${reason}_on_use`)
    return 'started'
  } catch (error) {
    console.log(JSON.stringify({ event: 'environment_refresh_on_use_failed', environmentId, error: String(error).slice(0, 160) }))
    return 'skipped'
  }
}
