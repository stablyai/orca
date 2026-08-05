// Phase 6 write ownership: WHEN coverage may be persisted.
//
// The governing rule is that coverage is written under PERMISSION B, not A. A run
// can legitimately still own its own row (A) while having lost the right to speak
// for the task (B) — a superseded artifact, a task that moved. In every such case
// the review row is finalized truthfully and NOT ONE coverage row is written,
// because a matrix that no longer describes the current plan is exactly what a
// later bug could mistake for evidence.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { derivePlanArtifact } from './audited-plan-artifact-derivation'
import { getCurrentPlanArtifact } from './audited-plan-artifact-repository'
import { startPlanReviewRun } from './audited-plan-review-run-repository'
import { finalizePlanReviewRun } from './audited-plan-review-run-finalize'
import { cancelPlanReviewRun } from './audited-plan-review-run-cancel'
import { recoverInterruptedPlanReviewRuns } from './audited-plan-review-run-recovery'
import { seedTriagedTask, startRun } from './audited-execution-test-fixtures'
import type { CoverageRow } from '../../shared/audited-plan-artifact-types'

let repository: AuditedTaskRepository
let userData: string

const COUNTERS = { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }

const COVERAGE: CoverageRow[] = [
  { criterionId: 'ac1', covered: true, note: 'Step 3 adds the parser' },
  { criterionId: 'ac2', covered: false, note: null }
]

const EXPECTED_IDENTITY = {
  worktreePath: '/tmp/wt',
  branchName: 'orca/audited-1',
  worktreeProvenance: 'orca_audited_v1',
  worktreeVerifiedAt: 10,
  worktreeReasonCode: null
} as const

function db() {
  return repository.getDatabase()
}

function makeTask(): string {
  return repository.createTask({
    repoId: 'repo1',
    sourceRepoPath: '/tmp/repo',
    baseCommit: 'a'.repeat(40),
    hostId: 'local',
    title: 'Do the thing',
    spec: { title: 'Do the thing', description: '' },
    source: 'custom',
    risk: 'low'
  }).id
}

function seedWorktreeIdentity(taskId: string): void {
  db()
    .prepare(
      `UPDATE audited_tasks
          SET worktree_path = ?, branch_name = ?, worktree_provenance = ?,
              worktree_verified_at_ms = ?, worktree_reason_code = NULL
        WHERE id = ?`
    )
    .run(
      EXPECTED_IDENTITY.worktreePath,
      EXPECTED_IDENTITY.branchName,
      EXPECTED_IDENTITY.worktreeProvenance,
      EXPECTED_IDENTITY.worktreeVerifiedAt,
      taskId
    )
}

function seedReviewableTask(): { taskId: string; artifactId: string; sha: string } {
  const taskId = makeTask()
  seedTriagedTask(repository, taskId, 'plan')
  const runId = startRun(repository, taskId, 'plan')
  const derived = derivePlanArtifact(
    db(),
    userData,
    {
      taskId,
      runId,
      round: 0,
      rawPlanText: '1. Do the thing.',
      sanitizationContext: {},
      counters: COUNTERS
    },
    1_000
  )
  if (!derived.ok) {
    throw new Error('failed to seed')
  }
  seedWorktreeIdentity(taskId)
  const artifact = getCurrentPlanArtifact(db(), taskId)!
  return { taskId, artifactId: artifact.id, sha: artifact.contentSha256 }
}

function startReview(taskId: string, artifactId: string, sha: string): string {
  const started = startPlanReviewRun(
    db(),
    {
      taskId,
      artifactId,
      artifactSha256: sha,
      round: 0,
      worktreeVerifiedAtMs: EXPECTED_IDENTITY.worktreeVerifiedAt,
      expectedWorktreeIdentity: EXPECTED_IDENTITY,
      auditMode: 'codex_cli' as const
    },
    1_000
  )
  if (!started.ok) {
    throw new Error(`failed to start review: ${started.reasonCode}`)
  }
  return started.runId
}

function coverageRowCount(taskId: string): number {
  return (
    db()
      .prepare(`SELECT COUNT(*) as n FROM audited_plan_coverage WHERE task_id = ?`)
      .get(taskId) as { n: number }
  ).n
}

function transitionCount(taskId: string): number {
  return (
    db().prepare(`SELECT COUNT(*) as n FROM audited_transitions WHERE task_id = ?`).get(taskId) as {
      n: number
    }
  ).n
}

const APPROVED_ARGS = {
  status: 'succeeded' as const,
  reasonCode: null,
  verdict: 'approved' as const,
  summary: 'Looks right',
  findingCount: 0,
  toState: null,
  blockedReasonCode: null,
  preBlockState: null,
  blockedPhase: null,
  eventType: 'plan_review_approved_verdict',
  counters: COUNTERS
}

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  userData = mkdtempSync(join(tmpdir(), 'orca-coverage-write-'))
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
  rmSync(userData, { recursive: true, force: true })
})

describe('coverage is written only when the run may speak for the task', () => {
  it('persists one row per criterion on a fresh approved verdict', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)

    const result = finalizePlanReviewRun(
      db(),
      { runId, taskId, ...APPROVED_ARGS, coverage: COVERAGE },
      2_000
    )

    expect(result).toEqual({ ok: true, taskWritten: true })
    const rows = db()
      .prepare(`SELECT * FROM audited_plan_coverage WHERE run_id = ? ORDER BY criterion_id`)
      .all(runId) as { criterion_id: string; covered: number; note: string | null }[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      criterion_id: 'ac1',
      covered: 1,
      note: 'Step 3 adds the parser'
    })
    expect(rows[1]).toMatchObject({ criterion_id: 'ac2', covered: 0, note: null })
  })

  // R4. The run still owns its row (permission A) but no longer describes the
  // current plan (permission B), so it records why it was discarded and writes
  // no coverage at all.
  it('writes NO coverage when the artifact was superseded mid-run', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)

    // A revision lands while the audit is in flight.
    db()
      .prepare(`UPDATE audited_plan_artifacts SET status = 'superseded' WHERE id = ?`)
      .run(artifactId)

    const result = finalizePlanReviewRun(
      db(),
      { runId, taskId, ...APPROVED_ARGS, coverage: COVERAGE },
      2_000
    )

    expect(result).toEqual({ ok: true, taskWritten: false })
    expect(coverageRowCount(taskId)).toBe(0)
    const run = db()
      .prepare(`SELECT status, reason_code, verdict FROM audited_plan_review_runs WHERE id = ?`)
      .get(runId)
    expect(run).toMatchObject({
      status: 'failed',
      reason_code: 'artifact_superseded',
      verdict: null
    })
  })

  // R5. A concurrent block moved the task. Coverage must not be recorded, and the
  // task row must be byte-identical afterwards.
  it('writes NO coverage and leaves the task untouched when it moved state', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)
    db().prepare(`UPDATE audited_tasks SET state = 'blocked' WHERE id = ?`).run(taskId)
    const before = db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(taskId)

    finalizePlanReviewRun(db(), { runId, taskId, ...APPROVED_ARGS, coverage: COVERAGE }, 2_000)

    expect(coverageRowCount(taskId)).toBe(0)
    expect(db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(taskId)).toEqual(before)
  })

  // R6. The PRIMARY KEY is the last line of defense: even if permission A somehow
  // passed twice, a duplicate row set cannot be created.
  it('refuses a duplicate finalize and leaves exactly one row set', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)
    finalizePlanReviewRun(db(), { runId, taskId, ...APPROVED_ARGS, coverage: COVERAGE }, 2_000)

    const second = finalizePlanReviewRun(
      db(),
      { runId, taskId, ...APPROVED_ARGS, coverage: COVERAGE },
      3_000
    )

    expect(second).toEqual({ ok: false, reasonCode: 'lock_contended' })
    expect(coverageRowCount(taskId)).toBe(2)
  })

  // R7. Cancel finalizes the run without ever reaching finalizePlanReviewRun.
  it('records no coverage for a cancelled run', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)

    expect(cancelPlanReviewRun(db(), { runId, taskId }, 2_000)).toEqual({ ok: true })
    expect(coverageRowCount(taskId)).toBe(0)
  })

  // R8. An interrupted run never finalized, so it contributed nothing.
  it('records no coverage for a run interrupted by a restart', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    startReview(taskId, artifactId, sha)

    expect(recoverInterruptedPlanReviewRuns(db(), 5_000)).toHaveLength(1)
    expect(coverageRowCount(taskId)).toBe(0)
  })

  it('writes coverage for a fixes_requested verdict, where a partial matrix matters most', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)

    finalizePlanReviewRun(
      db(),
      {
        runId,
        taskId,
        ...APPROVED_ARGS,
        verdict: 'fixes_requested',
        toState: 'plan_fixes_requested',
        eventType: 'plan_review_fixes_requested',
        coverage: COVERAGE
      },
      2_000
    )

    expect(coverageRowCount(taskId)).toBe(2)
  })
})

// R6b. THE EVENT CONTRACT. Phase 6 adds no transition row and no event type;
// several Phase 5 suites assert an exact transition COUNT as a "nothing extra was
// written" invariant, and this pins that those stay true.
describe('the finalization transition is unchanged in count and type', () => {
  it('writes exactly ONE transition, keeping the existing event type', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)
    const before = transitionCount(taskId)

    finalizePlanReviewRun(db(), { runId, taskId, ...APPROVED_ARGS, coverage: COVERAGE }, 2_000)

    expect(transitionCount(taskId)).toBe(before + 1)
    const row = db()
      .prepare(
        `SELECT event_type, detail_json FROM audited_transitions
          WHERE task_id = ? ORDER BY seq DESC LIMIT 1`
      )
      .get(taskId) as { event_type: string; detail_json: string | null }
    expect(row.event_type).toBe('plan_review_approved_verdict')
    expect(JSON.parse(row.detail_json!)).toEqual({ covered: 1, total: 2 })
  })

  // Counts only. The matrix itself lives in the immutable coverage table; leaking
  // ids or note text into an append-only log would duplicate it in a place that
  // no redaction pass revisits.
  it('records counts only, never ids or note text', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)

    finalizePlanReviewRun(db(), { runId, taskId, ...APPROVED_ARGS, coverage: COVERAGE }, 2_000)

    const detail = (
      db()
        .prepare(
          `SELECT detail_json FROM audited_transitions WHERE task_id = ? ORDER BY seq DESC LIMIT 1`
        )
        .get(taskId) as { detail_json: string }
    ).detail_json
    expect(detail).not.toContain('ac1')
    expect(detail).not.toContain('Step 3')
    expect(Object.keys(JSON.parse(detail)).sort()).toEqual(['covered', 'total'])
  })

  it('leaves detail_json NULL when there is no coverage, exactly as before Phase 6', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)

    finalizePlanReviewRun(db(), { runId, taskId, ...APPROVED_ARGS, coverage: [] }, 2_000)

    const row = db()
      .prepare(
        `SELECT detail_json FROM audited_transitions WHERE task_id = ? ORDER BY seq DESC LIMIT 1`
      )
      .get(taskId) as { detail_json: string | null }
    expect(row.detail_json).toBeNull()
  })
})
