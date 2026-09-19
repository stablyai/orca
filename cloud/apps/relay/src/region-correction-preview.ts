import type { RelayDatabase, SqlRow } from './database.js'
import { REGIONAL_REHOME_DEFAULT_HOST_COOLDOWN_MS } from './database.js'
import {
  REGIONAL_REHOME_CONCURRENT_LIMIT,
  REGION_DECISION_TTL_MS
} from './region-correction-state.js'

export type RegionCorrectionPreview = {
  observedAt: number
  newClaimsEnabled: boolean
  cohortPercent: number
  openMigrations: number
  availableMigrationSlots: number
  globalSafetyFailure: string | null
  counts: Record<string, number>
}

export async function previewRegionalRehomeEligibility(input: {
  database: RelayDatabase
  now: number
  heartbeatTtlMs: number
  cohortPercent: number
  globalSafetyFailure: string | null
  connectionHeadroom: ReadonlyMap<string, boolean>
  cellIsClean: (safety: SqlRow | undefined, runtime: SqlRow, now: number) => boolean
}): Promise<RegionCorrectionPreview> {
  const { database, now } = input
  const [hosts, cells, runtimeRows, capabilityRows, safetyRows, controls, migrations] =
    await Promise.all([
      database.query(
        `SELECT assignment.cell_id, assignment.assignment_epoch,
      decision.generation, decision.assignment_epoch AS decision_epoch, decision.expires_at,
      decision.incumbent_region, decision.preferred_region, decision.outcome, decision.policy_version,
      decision.observed_at, decision.cohort_bucket,
      (SELECT MAX(attempt.created_at) FROM relay_region_rehome_attempts attempt
       WHERE attempt.user_id = assignment.user_id AND attempt.relay_host_id = assignment.relay_host_id) AS last_attempt_at,
      (SELECT COUNT(*) FROM relay_assignment_migrations migration
       WHERE migration.user_id = assignment.user_id AND migration.relay_host_id = assignment.relay_host_id
         AND migration.completed_at IS NULL AND migration.aborted_at IS NULL) AS open_migrations,
      (SELECT COALESCE(SUM(lease.request_units),0) FROM relay_assignment_activity_leases lease
       WHERE lease.user_id = assignment.user_id AND lease.relay_host_id = assignment.relay_host_id
         AND lease.cell_id = assignment.cell_id) AS source_units,
      (SELECT COUNT(*) FROM relay_control_capabilities host_capability
       JOIN relay_assignment_activity_leases lease ON lease.user_id = host_capability.user_id
         AND lease.relay_host_id = host_capability.relay_host_id AND lease.activity_id = host_capability.activity_id
       JOIN relay_cell_runtime runtime ON runtime.cell_id = host_capability.cell_id
         AND runtime.cell_incarnation = host_capability.cell_incarnation
       WHERE host_capability.user_id = assignment.user_id AND host_capability.relay_host_id = assignment.relay_host_id
         AND host_capability.cell_id = assignment.cell_id AND host_capability.assignment_epoch = assignment.assignment_epoch
         AND host_capability.idle_regional_rehome = 1 AND lease.activity_kind = 'control'
         AND lease.activity_id NOT LIKE 'control-pending:%' AND lease.expires_at > ?
         AND lease.updated_at >= runtime.started_at) AS capable_controls
      FROM relay_assignments assignment LEFT JOIN relay_region_decisions decision
        ON decision.user_id = assignment.user_id AND decision.relay_host_id = assignment.relay_host_id`,
        [now]
      ),
      database.query(`SELECT cell.*, region.region, admission.admission_state FROM relay_cells cell
      LEFT JOIN relay_cell_regions region ON region.cell_id = cell.cell_id
      LEFT JOIN relay_cell_admission admission ON admission.cell_id = cell.cell_id`),
      database.query(`SELECT * FROM relay_cell_runtime`),
      database.query(`SELECT * FROM relay_cell_capabilities`),
      database.query(`SELECT * FROM relay_cell_rehome_safety`),
      database.query(`SELECT * FROM relay_region_rehome_control WHERE control_id = 'global'`),
      database.query(
        `SELECT COUNT(*) AS count FROM relay_assignment_migrations WHERE completed_at IS NULL AND aborted_at IS NULL`
      )
    ])
  const byCell = (rows: SqlRow[]) => new Map(rows.map((row) => [String(row.cell_id), row]))
  const runtimes = byCell(runtimeRows)
  const capabilities = byCell(capabilityRows)
  const safety = byCell(safetyRows)
  const inventory = byCell(cells)
  const control = controls[0]
  const cooldown = Number(control?.host_cooldown_ms ?? REGIONAL_REHOME_DEFAULT_HOST_COOLDOWN_MS)
  const maxAge = Number(control?.preference_max_age_ms ?? REGION_DECISION_TTL_MS)
  const openMigrations = Number(migrations[0]?.count ?? 0)
  const counts: Record<string, number> = {}
  const count = (reason: string) => {
    counts[reason] = (counts[reason] ?? 0) + 1
  }
  const available = (cell: SqlRow): boolean => {
    const id = String(cell.cell_id)
    const runtime = runtimes.get(id)
    const capability = capabilities.get(id)
    return (
      Number(cell.enabled) === 1 &&
      cell.admission_state === 'general' &&
      cell.region != null &&
      runtime !== undefined &&
      Number(runtime.ready) === 1 &&
      Number(runtime.last_heartbeat_at) > now - input.heartbeatTtlMs &&
      capability !== undefined &&
      capability.cell_incarnation === runtime.cell_incarnation &&
      Number(capability.regional_rehome_protocol) >= 3
    )
  }
  for (const host of hosts) {
    let reason: string | null = null
    const source = inventory.get(String(host.cell_id))
    if (host.generation == null) reason = 'no-verified-decision'
    else if (Number(host.expires_at) <= now || Number(host.observed_at) < now - maxAge)
      reason = 'expired'
    else if (
      Number(host.decision_epoch) !== Number(host.assignment_epoch) ||
      host.incumbent_region !== source?.region
    )
      reason = 'basis-changed'
    else if (
      host.outcome !== 'conclusive' ||
      Number(host.policy_version) !== 1 ||
      host.preferred_region == null
    )
      reason = 'inconclusive-or-insufficient-improvement'
    else if (Number(host.cohort_bucket) >= input.cohortPercent) reason = 'outside-cohort'
    else if (Number(host.open_migrations) > 0) reason = 'migration-open'
    else if (host.last_attempt_at != null && Number(host.last_attempt_at) > now - cooldown)
      reason = 'host-cooldown'
    else if (!source || !available(source)) reason = 'source-ineligible'
    else if (Number(host.capable_controls) === 0) reason = 'source-control-unsupported-or-inactive'
    else if (
      !input.cellIsClean(safety.get(String(host.cell_id)), runtimes.get(String(host.cell_id))!, now)
    )
      reason = 'source-unclean'
    if (reason) {
      count(reason)
      continue
    }
    const targets = cells.filter(
      (cell) =>
        cell.cell_id !== host.cell_id && cell.region === host.preferred_region && available(cell)
    )
    const clean = targets.filter((cell) =>
      input.cellIsClean(safety.get(String(cell.cell_id)), runtimes.get(String(cell.cell_id))!, now)
    )
    const capacity = clean.filter(
      (cell) =>
        input.connectionHeadroom.get(String(cell.cell_id)) !== false &&
        Number(cell.reserved_requests) + Number(host.source_units) + 1 <=
          Number(cell.capacity_requests)
    )
    if (targets.length === 0) count('no-eligible-target')
    else if (clean.length === 0) count('target-unclean')
    else if (capacity.length === 0) count('no-target-headroom')
    else if (input.globalSafetyFailure) count('global-safety-blocked')
    else if (openMigrations >= REGIONAL_REHOME_CONCURRENT_LIMIT) count('concurrent-migration-cap')
    else count(`eligible:${host.incumbent_region}-to-${host.preferred_region}`)
  }
  return {
    observedAt: now,
    newClaimsEnabled: Number(control?.enabled ?? 0) === 1,
    cohortPercent: input.cohortPercent,
    openMigrations,
    availableMigrationSlots: Math.max(0, REGIONAL_REHOME_CONCURRENT_LIMIT - openMigrations),
    globalSafetyFailure: input.globalSafetyFailure,
    counts
  }
}
