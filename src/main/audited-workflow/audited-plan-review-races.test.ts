// CAS-protected admission (plan §7.1) and the two-permission finalization model
// (plan §6).
//
// The two properties under test:
//   1. an OBSOLETE artifact never produces a review row and never reaches a
//      spawn;
//   2. a STALE verdict is recorded as discarded but CANNOT touch the task.
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
import {
  getPlanReviewRun,
  hasApprovedVerdictForCurrentArtifact,
  startPlanReviewRun
} from './audited-plan-review-run-repository'
import { finalizePlanReviewRun } from './audited-plan-review-run-finalize'
import { approvePlan } from './audited-plan-review-approval'
import { seedTriagedTask, startRun } from './audited-execution-test-fixtures'

let repository: AuditedTaskRepository
let userData: string

const COUNTERS = { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }

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

/** Produces a task in awaiting_plan_review with one current artifact. */
function seedReviewableTask(planText = '1. Do the thing.'): {
  taskId: string
  artifactId: string
  sha: string
} {
  const taskId = makeTask()
  seedTriagedTask(repository, taskId, 'plan')
  const runId = startRun(repository, taskId, 'plan')
  const derived = derivePlanArtifact(
    repository.getDatabase(),
    userData,
    { taskId, runId, round: 0, rawPlanText: planText, sanitizationContext: {}, counters: COUNTERS },
    1_000
  )
  if (!derived.ok) {
    throw new Error('failed to seed a reviewable task')
  }
  seedWorktreeIdentity(taskId)
  const artifact = getCurrentPlanArtifact(repository.getDatabase(), taskId)!
  return { taskId, artifactId: artifact.id, sha: artifact.contentSha256 }
}

/** Simulates a completed revision: a new artifact supersedes the current one. */
function reviseWithNewArtifact(taskId: string): string {
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks SET state = 'planning', plan_round = plan_round + 1 WHERE id = ?`
    )
    .run(taskId)
  const runId = startRun(repository, taskId, 'plan')
  const derived = derivePlanArtifact(
    repository.getDatabase(),
    userData,
    {
      taskId,
      runId,
      round: 1,
      rawPlanText: '1. A different plan.',
      sanitizationContext: {},
      counters: COUNTERS
    },
    2_000
  )
  if (!derived.ok) {
    throw new Error('failed to revise')
  }
  return getCurrentPlanArtifact(repository.getDatabase(), taskId)!.id
}

function reviewRunCount(taskId: string): number {
  const row = repository
    .getDatabase()
    .prepare(`SELECT COUNT(*) as n FROM audited_plan_review_runs WHERE task_id = ?`)
    .get(taskId) as { n: number }
  return row.n
}

function snapshotTask(taskId: string) {
  return repository.getDatabase().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(taskId)
}

function transitionCount(taskId: string): number {
  const row = repository
    .getDatabase()
    .prepare(`SELECT COUNT(*) as n FROM audited_transitions WHERE task_id = ?`)
    .get(taskId) as { n: number }
  return row.n
}

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  userData = mkdtempSync(join(tmpdir(), 'orca-review-race-'))
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
  rmSync(userData, { recursive: true, force: true })
})

describe('admission CAS', () => {
  it('admits a review for the current artifact', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const started = startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: EXPECTED_IDENTITY
      },
      1_000
    )
    expect(started.ok).toBe(true)
    expect(reviewRunCount(taskId)).toBe(1)
  })

  // The race the CAS exists for: the orchestration read the artifact, then a
  // revision completed before it could open the write transaction.
  it('creates NO review row when the artifact was superseded after being read', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    reviseWithNewArtifact(taskId)
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'awaiting_plan_review' WHERE id = ?`)
      .run(taskId)

    const started = startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: EXPECTED_IDENTITY
      },
      3_000
    )

    expect(started).toEqual({ ok: false, reasonCode: 'artifact_superseded' })
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('creates NO review row when the hash moved under a matching id', () => {
    const { taskId, artifactId } = seedReviewableTask()
    const started = startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: 'deadbeef',
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: EXPECTED_IDENTITY
      },
      1_000
    )
    expect(started).toEqual({ ok: false, reasonCode: 'artifact_superseded' })
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('creates NO review row when the task left awaiting_plan_review', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'planning' WHERE id = ?`)
      .run(taskId)

    const started = startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: EXPECTED_IDENTITY
      },
      1_000
    )
    expect(started).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('rejects a duplicate concurrent start via the partial unique index', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const args = {
      taskId,
      artifactId,
      artifactSha256: sha,
      round: 0,
      worktreeVerifiedAtMs: 1,
      expectedWorktreeIdentity: EXPECTED_IDENTITY
    }
    expect(startPlanReviewRun(repository.getDatabase(), args, 1_000).ok).toBe(true)

    const second = startPlanReviewRun(repository.getDatabase(), args, 1_001)
    expect(second).toEqual({ ok: false, reasonCode: 'lock_contended' })
    expect(reviewRunCount(taskId)).toBe(1)
  })
})

describe('finalization permissions', () => {
  function startReview(taskId: string, artifactId: string, sha: string): string {
    const started = startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: EXPECTED_IDENTITY
      },
      1_000
    )
    if (!started.ok) {
      throw new Error('failed to start review')
    }
    return started.runId
  }

  const FIXES_ARGS = {
    status: 'succeeded' as const,
    reasonCode: null,
    verdict: 'fixes_requested' as const,
    summary: 'Needs work',
    findingCount: 2,
    toState: 'plan_fixes_requested' as const,
    blockedReasonCode: null,
    preBlockState: null,
    blockedPhase: null,
    eventType: 'plan_review_fixes_requested',
    // Phase 6. Empty here so these Phase 5 races keep asserting exactly what they
    // always did; the coverage write path has its own suite.
    coverage: [],
    counters: COUNTERS
  }

  it('A + B hold: writes both the review row and the task', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)

    const result = finalizePlanReviewRun(
      repository.getDatabase(),
      { runId, taskId, ...FIXES_ARGS },
      2_000
    )

    expect(result).toEqual({ ok: true, taskWritten: true })
    expect(repository.getTask(taskId)!.state).toBe('plan_fixes_requested')
    expect(repository.getTask(taskId)!.lastVerdict).toBe('fixes_requested')
  })

  it('A fails: a run already finalized by cancel cannot be re-finalized', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)
    repository
      .getDatabase()
      .prepare(`UPDATE audited_plan_review_runs SET status = 'cancelled' WHERE id = ?`)
      .run(runId)
    const before = snapshotTask(taskId)

    const result = finalizePlanReviewRun(
      repository.getDatabase(),
      { runId, taskId, ...FIXES_ARGS },
      2_000
    )

    expect(result).toEqual({ ok: false, reasonCode: 'lock_contended' })
    expect(snapshotTask(taskId)).toEqual(before)
  })

  // THE stale-verdict property.
  it('B fails (superseded): records the discard and leaves the task byte-identical', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)

    reviseWithNewArtifact(taskId)
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'awaiting_plan_review' WHERE id = ?`)
      .run(taskId)
    const before = snapshotTask(taskId)
    const transitionsBefore = transitionCount(taskId)

    const result = finalizePlanReviewRun(
      repository.getDatabase(),
      {
        runId,
        taskId,
        ...FIXES_ARGS,
        verdict: 'approved',
        toState: null
      },
      3_000
    )

    expect(result).toEqual({ ok: true, taskWritten: false })
    expect(snapshotTask(taskId)).toEqual(before)
    expect(transitionCount(taskId)).toBe(transitionsBefore)

    const run = getPlanReviewRun(repository.getDatabase(), runId)!
    expect(run.status).toBe('failed')
    expect(run.reasonCode).toBe('artifact_superseded')
    // Never a durable `approved` a later bug could mistake for authorization.
    expect(run.verdict).toBeNull()
  })

  it('B fails (task moved): records task_state_changed and touches nothing', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'planning' WHERE id = ?`)
      .run(taskId)
    const before = snapshotTask(taskId)

    const result = finalizePlanReviewRun(
      repository.getDatabase(),
      { runId, taskId, ...FIXES_ARGS, verdict: 'approved', toState: null },
      3_000
    )

    expect(result).toEqual({ ok: true, taskWritten: false })
    expect(snapshotTask(taskId)).toEqual(before)
    const run = getPlanReviewRun(repository.getDatabase(), runId)!
    expect(run.reasonCode).toBe('task_state_changed')
    expect(run.verdict).toBeNull()
  })

  it('an approved verdict records itself WITHOUT advancing the task', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)

    finalizePlanReviewRun(
      repository.getDatabase(),
      {
        runId,
        taskId,
        ...FIXES_ARGS,
        verdict: 'approved',
        summary: 'Looks right',
        findingCount: 0,
        toState: null,
        eventType: 'plan_review_approved_verdict'
      },
      2_000
    )

    // Codex authorizes; only the human click advances.
    expect(repository.getTask(taskId)!.state).toBe('awaiting_plan_review')
    expect(repository.getTask(taskId)!.lastVerdict).toBe('approved')
    expect(hasApprovedVerdictForCurrentArtifact(repository.getDatabase(), taskId)).toBe(true)
  })
})

describe('approvePlan authorization', () => {
  function approveAfterVerdict(verdict: 'approved' | 'fixes_requested' | 'blocked') {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const started = startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: EXPECTED_IDENTITY
      },
      1_000
    )
    if (!started.ok) {
      throw new Error('failed to start')
    }
    finalizePlanReviewRun(
      repository.getDatabase(),
      {
        runId: started.runId,
        taskId,
        status: 'succeeded',
        reasonCode: null,
        verdict,
        summary: 's',
        findingCount: 0,
        toState: null,
        blockedReasonCode: null,
        preBlockState: null,
        blockedPhase: null,
        eventType: 'plan_review_verdict',
        coverage: [],
        counters: COUNTERS
      },
      2_000
    )
    return { taskId, result: approvePlan(repository.getDatabase(), taskId, 3_000) }
  }

  it('advances to ready_to_implement on an approved verdict', () => {
    const { taskId, result } = approveAfterVerdict('approved')
    expect(result).toEqual({ ok: true })
    expect(repository.getTask(taskId)!.state).toBe('ready_to_implement')

    // The transition names the HUMAN, not codex.
    const row = repository
      .getDatabase()
      .prepare(
        `SELECT actor FROM audited_transitions WHERE task_id = ? AND to_state = 'ready_to_implement'`
      )
      .get(taskId) as { actor: string }
    expect(row.actor).toBe('human')
  })

  it.each(['fixes_requested', 'blocked'] as const)(
    'refuses approval after a %s verdict',
    (verdict) => {
      const { taskId, result } = approveAfterVerdict(verdict)
      expect(result).toEqual({ ok: false, reasonCode: 'no_approved_verdict' })
      expect(repository.getTask(taskId)!.state).toBe('awaiting_plan_review')
    }
  )

  it('refuses approval with no review at all', () => {
    const { taskId } = seedReviewableTask()
    expect(approvePlan(repository.getDatabase(), taskId, 3_000)).toEqual({
      ok: false,
      reasonCode: 'no_approved_verdict'
    })
  })

  it('refuses approval once the approved artifact is superseded', () => {
    const { taskId } = approveAfterVerdict('approved')
    // Undo the advance, then revise: the old approval must no longer authorize.
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'awaiting_plan_review' WHERE id = ?`)
      .run(taskId)
    reviseWithNewArtifact(taskId)
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'awaiting_plan_review' WHERE id = ?`)
      .run(taskId)

    expect(approvePlan(repository.getDatabase(), taskId, 4_000)).toEqual({
      ok: false,
      reasonCode: 'no_approved_verdict'
    })
  })

  it('is idempotent: a duplicate approve is refused', () => {
    const { taskId, result } = approveAfterVerdict('approved')
    expect(result.ok).toBe(true)
    expect(approvePlan(repository.getDatabase(), taskId, 4_000)).toEqual({
      ok: false,
      reasonCode: 'illegal_transition'
    })
  })
})

// The verified worktree identity every reviewable fixture carries. Admission
// now re-checks this inside its transaction, so a fixture without it would be
// refused with worktree_identity_changed rather than exercising the case under
// test.
const WT_PATH = 'C:\\orca\\wt'
const WT_BRANCH = 'audited/fixture'
const WT_VERIFIED_AT = 1
const EXPECTED_IDENTITY = {
  worktreePath: WT_PATH,
  branchName: WT_BRANCH,
  worktreeProvenance: 'orca_audited_v1',
  worktreeVerifiedAt: WT_VERIFIED_AT,
  worktreeReasonCode: null
} as const

function seedWorktreeIdentity(taskId: string): void {
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks SET worktree_path = ?, branch_name = ?,
         worktree_provenance = 'orca_audited_v1', worktree_verified_at_ms = ? WHERE id = ?`
    )
    .run(WT_PATH, WT_BRANCH, WT_VERIFIED_AT, taskId)
}
