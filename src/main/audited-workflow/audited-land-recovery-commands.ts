// The user-triggered command that can never mutate (Phase 10).
//
// Split from audited-land-orchestration.ts so that file stays within its line
// budget without a max-lines suppression — and, more usefully, so the module that
// CAN move a ref and the module that CANNOT are separated by file.
//
// NOTHING HERE CONSTRUCTS A MUTATION. recheckLand builds only reads. That is
// enforced by what this module imports: runLandRefUpdate, runLandWorktreeUpdate,
// and every land-write builder are absent.
import type { AuditedWorkflowRecheckLandResult } from '../../shared/audited-workflow-command-types'
import type Database from '../sqlite/sync-database'
import { getAuditedTaskRepository } from './audited-task-service'
import { failLandAttempt, getLatestLandAttempt } from './audited-land-attempt-repository'
import { classifyLandEvidence } from './audited-land-classification'
import { adoptLanded, broadcastIfProjectable } from './audited-land-completion'
import { readLandEvidence } from './audited-land-evidence'

/**
 * The user-triggered, READ-ONLY recovery path for an unconfirmed land.
 *
 * Classifies with the SAME function the startup sweep uses, so the two routes
 * cannot disagree. A retry land becomes possible only if this proves no_effect,
 * because admission requires that no `authorized` attempt exists.
 *
 * The Phase 9 publication gate is deliberately NOT re-evaluated here: it is an
 * ADMISSION precondition. This attempt was proven published when it was
 * authorized, and re-litigating eligibility now would let an unrelated later
 * publish failure strand a durable, already-applied land.
 */
export async function recheckLand(taskId: string): Promise<AuditedWorkflowRecheckLandResult> {
  const repo = getAuditedTaskRepository()
  const db = repo.getDatabase()

  const attempt = getLatestLandAttempt(db, taskId)
  if (!attempt || attempt.status !== 'authorized') {
    return { ok: false, kind: 'landing', reasonCode: 'illegal_transition' }
  }

  const evidence = await readLandEvidence(attempt)
  const verdict = classifyLandEvidence(attempt, evidence)

  switch (verdict.kind) {
    case 'exact_completion':
    case 'ref_moved':
    case 'ref_moved_worktree_partial': {
      const adopted = adoptLanded(db, {
        taskId,
        attemptId: attempt.id,
        landedSha: verdict.landedSha,
        landedBaseSha: attempt.intendedBaseSha,
        reasonCode: 'landed_recovered',
        advisory: verdict.advisory
      })
      if (!adopted) {
        return storedClassification(db, taskId)
      }
      return { ok: true, classification: verdict.kind, advisory: verdict.advisory }
    }
    case 'no_effect': {
      const wrote = failLandAttempt(
        db,
        {
          attemptId: attempt.id,
          taskId,
          status: 'failed_no_effect',
          reasonCode: 'interrupted',
          block: false
        },
        Date.now()
      )
      if (!wrote) {
        // Someone else classified it first; report what is PERSISTED rather than
        // our own reading, so the UI never shows a verdict nobody stored.
        return storedClassification(db, taskId)
      }
      broadcastIfProjectable(taskId)
      return { ok: true, classification: 'no_effect', advisory: null }
    }
    case 'ambiguous': {
      const wrote = failLandAttempt(
        db,
        {
          attemptId: attempt.id,
          taskId,
          status: 'failed_ambiguous',
          reasonCode: 'landing_evidence_ambiguous',
          block: true
        },
        Date.now()
      )
      if (!wrote) {
        return storedClassification(db, taskId)
      }
      broadcastIfProjectable(taskId)
      return { ok: true, classification: 'ambiguous', advisory: null }
    }
  }
}

/** Reports what is actually persisted after losing a classification race. */
function storedClassification(
  db: Database.Database,
  taskId: string
): AuditedWorkflowRecheckLandResult {
  const current = getLatestLandAttempt(db, taskId)
  if (!current) {
    return { ok: false, kind: 'landing', reasonCode: 'lock_contended' }
  }
  const classification =
    current.status === 'completed'
      ? current.landingAdvisory === null
        ? 'exact_completion'
        : 'ref_moved'
      : current.status === 'failed_ambiguous'
        ? 'ambiguous'
        : 'no_effect'
  return { ok: true, classification, advisory: current.landingAdvisory }
}
