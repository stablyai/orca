import { createHash } from 'node:crypto'
import { ensureControlPlaneTables, type ControlPlaneDatabaseHandle } from './control-plane-store'
import { routeKey, type RouteIdentity, type RouteRole } from './route-registry-types'

/** CORRECTION 1 — the scrubbed SCL model-performance ledger.
 *
 *  Scrubbing is structural, not procedural: every column is an id, an enum or a
 *  number. There is no free-text column a customer artefact, transcript excerpt
 *  or personal identifier could be written into, so no redaction pass can be
 *  forgotten.
 *
 *  Provenance: only `observed_runtime` (Orca measured it) and
 *  `imported_evidence` (an explicit evidence-backed import) are admissible. A
 *  prompt claim or a public benchmark is not a source and has no enum value.
 *
 *  Idempotency: `entry_id` is a hash of (outcomeId, dispatchId, role,
 *  routeKey), so replaying the same completion overwrites rather than
 *  double-counting a model's record.
 *
 *  Retention: `MODEL_PERFORMANCE_RETENTION_DAYS`, enforced by
 *  `pruneModelPerformanceLedger`. Nothing here is an input to routing — the
 *  ledger is measurement, never a ranking that selects a model.
 */

export const MODEL_PERFORMANCE_RETENTION_DAYS = 400

export type ModelPerformanceProvenance = 'observed_runtime' | 'imported_evidence'

export type FirstPassResult = 'accepted' | 'corrections_required' | 'failed' | 'UNKNOWN'

export type ModelPerformanceRow = {
  entry_id: string
  recorded_at: string
  route_key: string
  agent: string
  model: string | null
  model_version: string
  role: RouteRole
  task_classification: string
  first_pass_result: FirstPassResult
  correction_rounds: number
  reviewer_defects: number
  escaped_defects: number
  wall_clock_ms: number | null
  tool_calls: number | null
  context_tokens_used: number | null
  provider_limit_interrupted: number
  rescue_route_key: string | null
  provenance: ModelPerformanceProvenance
}

export type ModelPerformanceEntry = {
  outcomeId: string
  dispatchId: string
  identity: RouteIdentity
  /** Exact model/version as the provider reported it, or UNKNOWN. */
  modelVersion: string
  role: RouteRole
  taskClassification: string
  firstPassResult: FirstPassResult
  correctionRounds: number
  reviewerDefects: number
  escapedDefects: number
  wallClockMs: number | null
  toolCalls: number | null
  contextTokensUsed: number | null
  providerLimitInterrupted: boolean
  rescueIdentity: RouteIdentity | null
  provenance: ModelPerformanceProvenance
  recordedAt: string
}

export function modelPerformanceEntryId(entry: {
  outcomeId: string
  dispatchId: string
  role: RouteRole
  identity: RouteIdentity
}): string {
  return createHash('sha256')
    .update([entry.outcomeId, entry.dispatchId, entry.role, routeKey(entry.identity)].join('|'))
    .digest('hex')
    .slice(0, 32)
}

export function toModelPerformanceRow(entry: ModelPerformanceEntry): ModelPerformanceRow {
  return {
    entry_id: modelPerformanceEntryId(entry),
    recorded_at: entry.recordedAt,
    route_key: routeKey(entry.identity),
    agent: entry.identity.agent,
    model: entry.identity.model,
    model_version: entry.modelVersion,
    role: entry.role,
    task_classification: entry.taskClassification,
    first_pass_result: entry.firstPassResult,
    correction_rounds: entry.correctionRounds,
    reviewer_defects: entry.reviewerDefects,
    escaped_defects: entry.escapedDefects,
    wall_clock_ms: entry.wallClockMs,
    tool_calls: entry.toolCalls,
    context_tokens_used: entry.contextTokensUsed,
    provider_limit_interrupted: entry.providerLimitInterrupted ? 1 : 0,
    rescue_route_key: entry.rescueIdentity ? routeKey(entry.rescueIdentity) : null,
    provenance: entry.provenance
  }
}

export class ModelPerformanceLedger {
  private readonly handle: ControlPlaneDatabaseHandle

  constructor(handle: ControlPlaneDatabaseHandle) {
    this.handle = handle
    ensureControlPlaneTables(handle)
  }

  record(entry: ModelPerformanceEntry): ModelPerformanceRow {
    const row = toModelPerformanceRow(entry)
    this.handle.db
      .prepare(
        `INSERT OR REPLACE INTO control_plane_model_performance
           (entry_id, recorded_at, route_key, agent, model, model_version, role,
            task_classification, first_pass_result, correction_rounds, reviewer_defects,
            escaped_defects, wall_clock_ms, tool_calls, context_tokens_used,
            provider_limit_interrupted, rescue_route_key, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.entry_id,
        row.recorded_at,
        row.route_key,
        row.agent,
        row.model,
        row.model_version,
        row.role,
        row.task_classification,
        row.first_pass_result,
        row.correction_rounds,
        row.reviewer_defects,
        row.escaped_defects,
        row.wall_clock_ms,
        row.tool_calls,
        row.context_tokens_used,
        row.provider_limit_interrupted,
        row.rescue_route_key,
        row.provenance
      )
    return row
  }

  list(filterRouteKey?: string): ModelPerformanceRow[] {
    return (
      filterRouteKey
        ? this.handle.db
            .prepare(
              'SELECT * FROM control_plane_model_performance WHERE route_key = ? ORDER BY recorded_at DESC'
            )
            .all(filterRouteKey)
        : this.handle.db
            .prepare('SELECT * FROM control_plane_model_performance ORDER BY recorded_at DESC')
            .all()
    ) as ModelPerformanceRow[]
  }

  prune(nowMs: number, retentionDays: number = MODEL_PERFORMANCE_RETENTION_DAYS): number {
    const cutoff = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString()
    const before = this.list().length
    this.handle.db
      .prepare('DELETE FROM control_plane_model_performance WHERE recorded_at < ?')
      .run(cutoff)
    return before - this.list().length
  }
}
