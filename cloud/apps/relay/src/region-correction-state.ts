import { relayHostLogDigest } from './relay-host-log-digest.js'
import { createHash } from 'node:crypto'
import type {
  RegionCorrectionRequest,
  RegionCorrectionResponse,
  RelayRegion
} from '@orca-cloud/relay-contract'
import type { RelayDatabase } from './database.js'

type Identity = { userId: string; relayHostId: string }
export const REGION_DECISION_TTL_MS = 24 * 60 * 60_000
export const REGIONAL_REHOME_CONCURRENT_LIMIT = 8

export async function exchangeRegionCorrection(
  database: RelayDatabase,
  identity: Identity,
  request: RegionCorrectionRequest,
  assignmentEpoch: number,
  now: number
): Promise<RegionCorrectionResponse> {
  const result: RegionCorrectionResponse = await database.transaction(async (transaction) => {
    const assignment = (
      await transaction.queryLocked(
        `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    )[0]
    const region =
      assignment &&
      (
        await transaction.query(`SELECT region FROM relay_cell_regions WHERE cell_id = ?`, [
          assignment.cell_id
        ])
      )[0]
    if (!assignment || !region || Number(assignment.assignment_epoch) !== assignmentEpoch) {
      return { v: 1, reportStatus: 'basis-changed' }
    }
    const prior = (
      await transaction.queryLocked(
        `SELECT * FROM relay_region_decisions WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    )[0]
    if (request.action === 'issue-window') {
      const generation = Number(prior?.generation ?? 0) + 1
      if (!Number.isSafeInteger(generation)) throw new Error('region_generation_exhausted')
      const expiresAt = now + REGION_DECISION_TTL_MS
      const cohortBucket =
        createHash('sha256')
          .update(JSON.stringify([identity.userId, identity.relayHostId]))
          .digest()
          .readUInt32BE(0) % 100
      await transaction.query(
        `INSERT INTO relay_region_decisions
         (user_id, relay_host_id, generation, expires_at, assignment_epoch, incumbent_region,
          policy_version, outcome, preferred_region, observed_at, report_json, cohort_bucket)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', NULL, ?, NULL, ?)
         ON CONFLICT (user_id, relay_host_id) DO UPDATE SET
           generation = excluded.generation, expires_at = excluded.expires_at,
           assignment_epoch = excluded.assignment_epoch, incumbent_region = excluded.incumbent_region,
           policy_version = 1, outcome = 'pending', preferred_region = NULL,
           observed_at = excluded.observed_at, report_json = NULL, cohort_bucket = excluded.cohort_bucket`,
        [
          identity.userId,
          identity.relayHostId,
          generation,
          expiresAt,
          assignmentEpoch,
          region.region,
          now,
          cohortBucket
        ]
      )
      return {
        v: 1,
        window: {
          generation,
          expiresAt,
          assignmentEpoch,
          incumbentRegion: region.region as RelayRegion,
          policyVersion: 1
        }
      }
    }
    if (!prior || Number(prior.generation) !== request.generation)
      return { v: 1, reportStatus: 'stale' }
    if (Number(prior.policy_version) !== request.policyVersion)
      return { v: 1, reportStatus: 'stale' }
    if (Number(prior.expires_at) <= now) return { v: 1, reportStatus: 'expired' }
    if (
      request.assignmentEpoch !== assignmentEpoch ||
      Number(prior.assignment_epoch) !== assignmentEpoch ||
      prior.incumbent_region !== region.region
    ) {
      return { v: 1, reportStatus: 'basis-changed' }
    }
    // The first report wins, including an inconclusive tombstone.
    if (prior.outcome !== 'pending') return { v: 1, reportStatus: 'duplicate' }
    let preferredRegion: RelayRegion | null = null
    if (request.outcome === 'conclusive') {
      const incumbent = request.measurements[region.region as RelayRegion]
      const target: RelayRegion = region.region === 'us-central1' ? 'asia-east2' : 'us-central1'
      const targetRtt = request.measurements[target]
      if (incumbent - targetRtt >= 25 && targetRtt <= incumbent * 0.8) preferredRegion = target
    }
    await transaction.query(
      `UPDATE relay_region_decisions SET outcome = ?, preferred_region = ?, report_json = ?
       WHERE user_id = ? AND relay_host_id = ? AND generation = ?`,
      [
        request.outcome,
        preferredRegion,
        JSON.stringify(request),
        identity.userId,
        identity.relayHostId,
        request.generation
      ]
    )
    return { v: 1, reportStatus: 'accepted' }
  })
  if (request.action === 'report' && result.reportStatus === 'accepted') {
    const digest = relayHostLogDigest(identity.relayHostId)
    // Stable sampling includes unchanged hosts for before/after comparisons.
    if (Number.parseInt(digest.slice(0, 8), 16) % 10 === 0) {
      console.log(
        JSON.stringify({
          event: 'orca_relay_region_comparison',
          relayHostIdDigest: digest,
          assignmentEpoch,
          generation: request.generation,
          policyVersion: request.policyVersion,
          outcome: request.outcome,
          ...(request.outcome === 'conclusive' ? { measurements: request.measurements } : {})
        })
      )
    }
  }
  return result
}

export async function previewRegionCorrection(
  database: RelayDatabase,
  now: number
): Promise<Record<string, number>> {
  const rows = await database.query(
    `SELECT CASE WHEN decision.expires_at <= ? THEN 'expired'
       WHEN decision.assignment_epoch <> assignment.assignment_epoch THEN 'basis-changed'
       WHEN decision.outcome = 'pending' THEN 'pending'
       WHEN decision.preferred_region IS NULL THEN 'ineligible'
       ELSE decision.incumbent_region || '-to-' || decision.preferred_region END AS reason,
       COUNT(*) AS count
     FROM relay_region_decisions decision
     JOIN relay_assignments assignment ON assignment.user_id = decision.user_id
       AND assignment.relay_host_id = decision.relay_host_id
     GROUP BY reason`,
    [now]
  )
  return Object.fromEntries(rows.map((row) => [String(row.reason), Number(row.count)]))
}
