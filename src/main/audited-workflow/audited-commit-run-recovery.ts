// Startup recovery for commit attempts interrupted by a crash or restart
// (Phase 8).
//
// PIDs are deliberately NOT used for liveness — PID reuse makes "is it alive"
// unanswerable across a restart, and a wrong answer is worse than an honest
// classification. Recovery never fabricates an outcome; it reads Git evidence and
// records exactly what that evidence supports.
//
// A `completed` attempt is NEVER downgraded here. Phase C/D findings are
// advisories on a durable commit, so a sweep that re-runs them may write only
// post_commit_advisory.
import type Database from '../sqlite/sync-database'
import {
  completeCommitAttempt,
  failCommitAttempt,
  getAuthorizedCommitAttempts,
  getCommitAttempt
} from './audited-commit-attempt-repository'
import { classifyCommitEvidence } from './audited-commit-classification'
import { readCommitEvidence } from './audited-commit-evidence'

export type RecoveredCommitAttempt = {
  taskId: string
  attemptId: string
  classification: string
}

/**
 * Reconciles every `authorized` attempt against real Git evidence.
 *
 * Async because it reads Git, so it must be awaited before handler registration
 * completes; each attempt is independently CAS-guarded, so ordering against the
 * fire-and-forget worktree reconciliation does not matter.
 */
export async function recoverInterruptedCommitAttempts(
  db: Database.Database,
  nowMs: number
): Promise<RecoveredCommitAttempt[]> {
  const recovered: RecoveredCommitAttempt[] = []
  for (const { id, taskId } of getAuthorizedCommitAttempts(db)) {
    const outcome = await recoverOneAttempt(db, id, taskId, nowMs)
    if (outcome) {
      recovered.push(outcome)
    }
  }
  return recovered
}

async function recoverOneAttempt(
  db: Database.Database,
  attemptId: string,
  taskId: string,
  nowMs: number
): Promise<RecoveredCommitAttempt | null> {
  const attempt = getCommitAttempt(db, attemptId)
  if (!attempt || attempt.status !== 'authorized') {
    return null
  }
  const task = db
    .prepare(`SELECT state, worktree_path FROM audited_tasks WHERE id = ?`)
    .get(taskId) as { state: string; worktree_path: string | null } | undefined
  if (!task || !task.worktree_path) {
    return null
  }

  const evidence = await readCommitEvidence(task.worktree_path, attempt)
  const classification = classifyCommitEvidence(attempt, evidence)

  switch (classification.kind) {
    case 'exact_completion': {
      // Idempotent adopt: the ref moved and every channel matches, so the commit
      // genuinely happened before the crash.
      completeCommitAttempt(db, { attemptId, taskId, commitSha: classification.commitSha }, nowMs)
      return { taskId, attemptId, classification: classification.kind }
    }
    case 'no_effect':
    case 'partial_promotion':
    case 'orphan_commit': {
      // In all three the ref provably never moved, so nothing in the user's
      // history changed. Any objects present are unreferenced and gc-able; there
      // is nothing to clean and nothing to warn about.
      failCommitAttempt(
        db,
        {
          attemptId,
          taskId,
          status: 'failed_no_effect',
          reasonCode: 'interrupted',
          toState: task.state === 'committing' ? 'awaiting_human_approval' : null,
          blockedReasonCode: null
        },
        nowMs
      )
      return { taskId, attemptId, classification: classification.kind }
    }
    case 'ambiguous': {
      // Partial or unexplained evidence: block, keep it guarded, touch NO Git
      // state, and never offer an automatic fix.
      failCommitAttempt(
        db,
        {
          attemptId,
          taskId,
          status: 'failed_ambiguous',
          reasonCode: 'evidence_ambiguous',
          toState: task.state === 'committing' ? 'blocked' : null,
          blockedReasonCode: 'commit_attempt_evidence_ambiguous'
        },
        nowMs
      )
      return { taskId, attemptId, classification: classification.kind }
    }
  }
}
