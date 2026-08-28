import { ensureControlPlaneTables, type ControlPlaneDatabaseHandle } from './control-plane-store'
import type { RouteIdentity, TaskCapability } from './route-registry-types'

/** B7 (correction 2) — where the candidate order lives.
 *
 *  The control plane must never pick a provider. It reads an ORDER that the
 *  classifying layer (DCS/Sol, or the operator via the CLI) declared for this
 *  outcome, and validates each candidate against the certified registry. An
 *  outcome with no declared reviewer order produces a protected blocker, never
 *  an Orca-chosen model.
 */

export type OutcomePolicy = {
  outcomeId: string
  taskClassification: TaskCapability
  builderCandidates: RouteIdentity[]
  reviewerCandidates: RouteIdentity[]
  reviewCapabilities: TaskCapability[]
  allowUnknownQuota: boolean
}

export type OutcomePhaseKind = 'build' | 'review' | 'fix_first'

export type OutcomePhaseRow = {
  phase_id: string
  outcome_id: string
  run_id: string
  kind: OutcomePhaseKind
  task_id: string
  source_task_id: string | null
  source_dispatch_id: string | null
  bound_sha: string
  status: 'planned' | 'settled'
  created_at: string
}

export function emptyOutcomePolicy(outcomeId: string): OutcomePolicy {
  return {
    outcomeId,
    taskClassification: 'bounded_implementation',
    builderCandidates: [],
    reviewerCandidates: [],
    reviewCapabilities: [],
    allowUnknownQuota: false
  }
}

export class OutcomePolicyStore {
  private readonly handle: ControlPlaneDatabaseHandle

  constructor(handle: ControlPlaneDatabaseHandle) {
    this.handle = handle
    ensureControlPlaneTables(handle)
  }

  get(outcomeId: string): OutcomePolicy {
    const row = this.handle.db
      .prepare('SELECT * FROM control_plane_outcome_policy WHERE outcome_id = ?')
      .get(outcomeId) as Record<string, unknown> | undefined
    if (!row) {
      return emptyOutcomePolicy(outcomeId)
    }
    return {
      outcomeId,
      taskClassification: row.task_classification as TaskCapability,
      builderCandidates: JSON.parse(row.builder_candidates as string) as RouteIdentity[],
      reviewerCandidates: JSON.parse(row.reviewer_candidates as string) as RouteIdentity[],
      reviewCapabilities: JSON.parse(row.review_capabilities as string) as TaskCapability[],
      allowUnknownQuota: row.allow_unknown_quota === 1
    }
  }

  put(policy: OutcomePolicy): void {
    this.handle.db
      .prepare(
        `INSERT INTO control_plane_outcome_policy
           (outcome_id, task_classification, builder_candidates, reviewer_candidates,
            review_capabilities, allow_unknown_quota, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(outcome_id) DO UPDATE SET
           task_classification = excluded.task_classification,
           builder_candidates = excluded.builder_candidates,
           reviewer_candidates = excluded.reviewer_candidates,
           review_capabilities = excluded.review_capabilities,
           allow_unknown_quota = excluded.allow_unknown_quota,
           updated_at = datetime('now')`
      )
      .run(
        policy.outcomeId,
        policy.taskClassification,
        JSON.stringify(policy.builderCandidates),
        JSON.stringify(policy.reviewerCandidates),
        JSON.stringify(policy.reviewCapabilities),
        policy.allowUnknownQuota ? 1 : 0
      )
  }

  listPhases(outcomeId: string): OutcomePhaseRow[] {
    return this.handle.db
      .prepare(
        'SELECT * FROM control_plane_outcome_phases WHERE outcome_id = ? ORDER BY created_at ASC, rowid ASC'
      )
      .all(outcomeId) as OutcomePhaseRow[]
  }

  findPhaseByTask(taskId: string): OutcomePhaseRow | undefined {
    return this.handle.db
      .prepare('SELECT * FROM control_plane_outcome_phases WHERE task_id = ?')
      .get(taskId) as OutcomePhaseRow | undefined
  }

  /** Idempotent: the unique index on (source_dispatch_id, kind) makes a replayed
   *  completion reuse the phase it already created instead of forking a second
   *  reviewer Task. */
  insertPhase(row: Omit<OutcomePhaseRow, 'created_at' | 'status'>): OutcomePhaseRow {
    const existing = row.source_dispatch_id
      ? (this.handle.db
          .prepare(
            'SELECT * FROM control_plane_outcome_phases WHERE source_dispatch_id = ? AND kind = ?'
          )
          .get(row.source_dispatch_id, row.kind) as OutcomePhaseRow | undefined)
      : undefined
    if (existing) {
      return existing
    }
    this.handle.db
      .prepare(
        `INSERT INTO control_plane_outcome_phases
           (phase_id, outcome_id, run_id, kind, task_id, source_task_id, source_dispatch_id, bound_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.phase_id,
        row.outcome_id,
        row.run_id,
        row.kind,
        row.task_id,
        row.source_task_id,
        row.source_dispatch_id,
        row.bound_sha
      )
    return this.handle.db
      .prepare('SELECT * FROM control_plane_outcome_phases WHERE phase_id = ?')
      .get(row.phase_id) as OutcomePhaseRow
  }

  settlePhase(taskId: string): void {
    this.handle.db
      .prepare("UPDATE control_plane_outcome_phases SET status = 'settled' WHERE task_id = ?")
      .run(taskId)
  }

  /** How many FIX_FIRST rounds this outcome has already consumed. */
  countCorrectionRounds(outcomeId: string): number {
    const row = this.handle.db
      .prepare(
        "SELECT COUNT(*) AS n FROM control_plane_outcome_phases WHERE outcome_id = ? AND kind = 'fix_first'"
      )
      .get(outcomeId) as { n: number }
    return row.n
  }
}
