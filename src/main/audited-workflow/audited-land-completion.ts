// What happens once the source ref provably carries the audited sha (Phase 10).
//
// Split from audited-land-orchestration.ts so that file stays within its line
// budget without a max-lines suppression, and so the "the land is durable from
// here" rule lives in ONE place: the live protocol, the startup sweep, and the
// user's Recheck all call adoptLanded, so none of them can record a confirmed
// land as anything other than `completed`.
import { app } from 'electron'
import type { LandingAdvisoryCode } from '../../shared/audited-landing-types'
import type { LandingReasonCode } from '../../shared/audited-workflow-types'
import type Database from '../sqlite/sync-database'
import { getTaskProjection } from './audited-task-service'
import { broadcastAuditedTaskChanged } from './audited-workflow-broadcast'
import { completeLandAttempt } from './audited-land-attempt-repository'
import { releaseTaskStoresAndDelete } from './audited-candidate-store-gc'

export function broadcastIfProjectable(taskId: string): void {
  const projection = getTaskProjection(taskId)
  if (projection) {
    broadcastAuditedTaskChanged(projection)
  }
}

export type AdoptLandedArgs = {
  taskId: string
  attemptId: string
  landedSha: string
  landedBaseSha: string
  /** 'landed' for a fresh fast-forward; 'landed_recovered' for an idempotent adopt. */
  reasonCode: Extract<LandingReasonCode, 'landed' | 'landed_recovered'>
  advisory: LandingAdvisoryCode | null
}

/**
 * The ref is confirmed: the attempt becomes permanently `completed` and the task
 * reaches the TERMINAL `landed` state.
 *
 * This is the ONLY function that marks a land complete, so "a confirmed land is
 * never reported as failed" holds for the live protocol and both recovery routes
 * alike.
 */
export function adoptLanded(db: Database.Database, args: AdoptLandedArgs): boolean {
  const completed = completeLandAttempt(
    db,
    {
      attemptId: args.attemptId,
      taskId: args.taskId,
      landedSha: args.landedSha,
      landedBaseSha: args.landedBaseSha,
      reasonCode: args.reasonCode,
      advisory: args.advisory
    },
    Date.now()
  )
  if (!completed) {
    return false
  }
  broadcastIfProjectable(args.taskId)
  sweepOrphanedCandidateStores(db, args.taskId)
  return true
}

/**
 * ORPHAN SWEEP ONLY — candidate-store cleanup is NOT this lane's responsibility.
 *
 * Phase 8 releases stores when the task reaches `committed`
 * (see startCommit), and since landing is reachable only FROM `committed`, the
 * normal path finds nothing to do here. This exists solely for rows written by a
 * build that predates that cleanup, or whose directory deletion failed inertly at
 * the time.
 *
 * Idempotent by construction, not by assumption: releaseTaskStoresAndDelete
 * selects `WHERE task_id = ? AND store_bytes IS NOT NULL`, which Phase 8's call
 * already cleared — so the normal path selects zero rows and does nothing.
 */
function sweepOrphanedCandidateStores(db: Database.Database, taskId: string): void {
  try {
    releaseTaskStoresAndDelete(db, taskId, app.getPath('userData'))
  } catch (error) {
    // A deletion failure is inert: the land is already durable and terminal.
    console.error('[auditedWorkflow] Orphaned candidate store sweep failed after land:', error)
  }
}
