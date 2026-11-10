// Org environment snapshots are built on top of a golden image, so a workspace booted from one keeps
// that golden's orcad and VM scripts. After every golden swap this rebuilds, in the background, each
// environment whose active build came from an older golden:
// - same config as the active build (only the base image changes), billed like any build;
// - the active build keeps serving until the new one succeeds, then the normal newest-success
//   activation swaps it in atomically; the old snapshot stays as a rollback (pruneSnapshots keeps it);
// - a failed rebuild leaves the active build in place and shows the usual "update failed" state, and is
//   not retried for the same golden (the attempt is recorded by its base_snapshot_id);
// - rate-limited: a few starts per tick and a cap on builds in flight across all accounts.
// Staleness is exact: environment_builds.base_snapshot_id is the golden snapshot each build started from.
import type { SandboxCaller } from './auth'
import { parseConfig, startBuild, type BuildConfig, type BuildDeps, type BuildRow } from './environment-builds'
import type { EnvironmentRow } from './environments'

export const GOLDEN_REFRESH_USER = 'system:golden-refresh'

export type GoldenRefreshTick = { stale: number; started: number; skipped: number }

export async function refreshStaleEnvironments(
  deps: BuildDeps,
  options: { maxStartsPerTick?: number; maxInFlight?: number } = {}
): Promise<GoldenRefreshTick> {
  const golden = deps.config.goldenSnapshotId
  const maxStarts = options.maxStartsPerTick ?? 2
  const maxInFlight = options.maxInFlight ?? 3
  const { results: stale } = await deps.db
    .prepare(
      `SELECT e.*, b.config AS active_config FROM environments e
         JOIN environment_builds b ON b.id = e.active_build_id
        WHERE e.deleted_at IS NULL AND b.base_snapshot_id != ?
          AND NOT EXISTS (
            SELECT 1 FROM environment_builds x WHERE x.environment_id = e.id
               AND (x.status IN ('starting', 'running', 'snapshotting')
                    OR (x.base_snapshot_id = ? AND x.status != 'canceled')))
        ORDER BY e.updated_at DESC`
    )
    .bind(golden, golden)
    .all<EnvironmentRow & { active_config: BuildRow['config'] }>()
  const inFlight =
    (await deps.db
      .prepare(`SELECT count(*) AS n FROM environment_builds WHERE status IN ('starting', 'running', 'snapshotting')`)
      .first<{ n: number }>())?.n ?? 0
  let started = 0
  let skipped = 0
  for (const environment of stale) {
    if (started >= maxStarts || inFlight + started >= maxInFlight) {
      break
    }
    // An org-less account is its own admin; the build is attributed to the system, billed to the account.
    const caller: SandboxCaller = { userId: GOLDEN_REFRESH_USER, accountId: environment.account_id }
    const config: BuildConfig = parseConfig({ config: environment.active_config })
    try {
      const build = await startBuild(deps, caller, environment, { config })
      started++
      console.log(JSON.stringify({ event: 'environment_golden_refresh_started', environmentId: environment.id, buildId: build.id }))
    } catch (error) {
      // Entitlement denied, kill switch, a racing manual build: try again on a later golden or tick.
      skipped++
      console.log(JSON.stringify({ event: 'environment_golden_refresh_skipped', environmentId: environment.id, error: String(error).slice(0, 160) }))
    }
  }
  return { stale: stale.length, started, skipped }
}
