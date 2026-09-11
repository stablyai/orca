import { createHash } from 'node:crypto'
import type { IdleRegionalRehomeRequest } from '@orca-cloud/relay-contract'
import type { RelayDatabase, SqlRow } from './database.js'

export const IDLE_REHOME_PAGE_SIZE = 100

export async function selectIdleRegionalRehomes(input: {
  database: RelayDatabase
  now: number
  heartbeatTtlMs: number
  cohortPercent: number
  offset: number
  connectionHeadroom: Map<string, boolean>
  cellIsClean: (safety: SqlRow | undefined, runtime: SqlRow, now: number) => boolean
}): Promise<Array<IdleRegionalRehomeRequest & { sourceCellUrl: string }>> {
  const [runtimes, safetyRows] = await Promise.all([
    input.database.query('SELECT * FROM relay_cell_runtime'),
    input.database.query('SELECT * FROM relay_cell_rehome_safety')
  ])
  const cleanCells = runtimes
    .filter((runtime) =>
      input.cellIsClean(
        safetyRows.find((safety) => safety.cell_id === runtime.cell_id),
        runtime,
        input.now
      )
    )
    .map((runtime) => String(runtime.cell_id))
  const targetCells = cleanCells.filter((id) => input.connectionHeadroom.get(id) !== false)
  if (!cleanCells.length || !targetCells.length) return []
  const rows = await input.database.query(
    `SELECT a.user_id, a.relay_host_id, a.cell_id AS source_cell_id,
       a.assignment_epoch, host.generation, r.cell_incarnation,
       s.cell_url, target.cell_id AS target_cell_id
     FROM relay_region_rehome_control policy
     JOIN relay_region_decisions d ON d.outcome = 'conclusive'
     JOIN relay_assignments a ON a.user_id = d.user_id AND a.relay_host_id = d.relay_host_id
     JOIN relay_cells s ON s.cell_id = a.cell_id AND s.enabled = 1
     JOIN relay_cell_regions sr ON sr.cell_id = a.cell_id
     JOIN relay_cell_admission sa ON sa.cell_id = a.cell_id AND sa.admission_state = 'general'
     JOIN relay_cell_runtime r ON r.cell_id = a.cell_id AND r.ready = 1
     JOIN relay_cell_capabilities c ON c.cell_id = r.cell_id AND c.cell_incarnation = r.cell_incarnation
     JOIN relay_control_capabilities host ON host.user_id = a.user_id AND host.relay_host_id = a.relay_host_id
       AND host.cell_id = a.cell_id AND host.assignment_epoch = a.assignment_epoch
       AND host.cell_incarnation = r.cell_incarnation AND host.idle_regional_rehome = 1
     JOIN relay_assignment_activity_leases lease ON lease.user_id = host.user_id
       AND lease.relay_host_id = host.relay_host_id AND lease.activity_id = host.activity_id
       AND lease.cell_id = a.cell_id AND lease.activity_kind = 'control'
     JOIN relay_cell_regions tr ON tr.region = d.preferred_region
     JOIN relay_cells target ON target.cell_id = tr.cell_id AND target.enabled = 1
     JOIN relay_cell_admission ta ON ta.cell_id = target.cell_id AND ta.admission_state = 'general'
     JOIN relay_cell_runtime rt ON rt.cell_id = target.cell_id AND rt.ready = 1
     JOIN relay_cell_capabilities ct ON ct.cell_id = rt.cell_id AND ct.cell_incarnation = rt.cell_incarnation
     WHERE policy.control_id = 'global' AND policy.enabled = 1 AND policy.not_before <= ?
       AND d.preferred_region <> sr.region AND d.incumbent_region = sr.region
       AND d.assignment_epoch = a.assignment_epoch AND d.policy_version = 1
       AND d.expires_at > ? AND d.observed_at >= ? - policy.preference_max_age_ms
       AND d.cohort_bucket < ? AND lease.expires_at > ? AND lease.updated_at >= r.started_at
       AND r.last_heartbeat_at > ? AND rt.last_heartbeat_at > ?
       AND s.cell_id IN (${cleanCells.map(() => '?').join(',')})
       AND target.cell_id IN (${targetCells.map(() => '?').join(',')})
       AND target.reserved_requests + 1 + (
         SELECT COALESCE(SUM(activity.request_units), 0)
         FROM relay_assignment_activity_leases activity
         WHERE activity.user_id = a.user_id AND activity.relay_host_id = a.relay_host_id
           AND activity.cell_id = a.cell_id
       ) <= target.capacity_requests
       AND c.regional_rehome_protocol >= 3 AND ct.regional_rehome_protocol >= 3
       AND NOT EXISTS (SELECT 1 FROM relay_assignment_migrations migration
         WHERE migration.user_id = a.user_id AND migration.relay_host_id = a.relay_host_id
           AND migration.completed_at IS NULL AND migration.aborted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM relay_region_rehome_attempts attempt
         WHERE attempt.user_id = a.user_id AND attempt.relay_host_id = a.relay_host_id
           AND attempt.created_at > ? - policy.host_cooldown_ms)
     ORDER BY a.user_id, a.relay_host_id, host.generation DESC,
       (target.reserved_requests + rt.observed_requests) * 1.0 / target.capacity_requests,
       target.cell_id
     LIMIT ? OFFSET ?`,
    [
      input.now,
      input.now,
      input.now,
      input.cohortPercent,
      input.now,
      input.now - input.heartbeatTtlMs,
      input.now - input.heartbeatTtlMs,
      ...cleanCells,
      ...targetCells,
      input.now,
      IDLE_REHOME_PAGE_SIZE,
      input.offset
    ]
  )
  return rows.map((row) => {
    const request = {
      v: 1 as const,
      userId: String(row.user_id),
      relayHostId: String(row.relay_host_id),
      sourceCellId: String(row.source_cell_id),
      sourceCellIncarnation: String(row.cell_incarnation),
      sourceAssignmentEpoch: Number(row.assignment_epoch),
      sourceGeneration: Number(row.generation),
      targetCellId: String(row.target_cell_id)
    }
    // UUIDv5 keeps retries on every director bound to the same source authority and target.
    const digest = createHash('sha1')
      .update(Buffer.from('0a1c5a9b197b4ea8b6f1f3bcaa3d712c', 'hex'))
      .update(JSON.stringify(request))
      .digest()
    digest[6] = (digest[6]! & 0x0f) | 0x50
    digest[8] = (digest[8]! & 0x3f) | 0x80
    const hex = digest.subarray(0, 16).toString('hex')
    const attemptId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    return { ...request, attemptId, sourceCellUrl: String(row.cell_url) }
  })
}
