// Revision lifecycle and round-cap semantics.
//
// planRound counts COMPLETED revision rounds (0 = the original plan). The cap
// binds when STARTING a revision and nowhere else — auditing and approving never
// consult it, so a round-3 plan stays fully auditable and approvable. Checking
// it at audit time would strand the final plan with no way to accept it.
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
import { requestPlanRevision } from './audited-plan-review-approval'
import { recoverInterruptedPlanReviewRuns } from './audited-plan-review-run-recovery'
import { cancelPlanReviewRun } from './audited-plan-review-run-cancel'
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
    title: 'T',
    spec: { title: 'T', description: '' },
    source: 'custom',
    risk: 'low'
  }).id
}

function seedReviewableTask(): { taskId: string; artifactId: string; sha: string } {
  const taskId = makeTask()
  seedTriagedTask(repository, taskId, 'plan')
  const runId = startRun(repository, taskId, 'plan')
  const derived = derivePlanArtifact(
    repository.getDatabase(),
    userData,
    { taskId, runId, round: 0, rawPlanText: 'plan', sanitizationContext: {}, counters: COUNTERS },
    1_000
  )
  if (!derived.ok) {
    throw new Error('seed failed')
  }
  seedWorktreeIdentity(taskId)
  const artifact = getCurrentPlanArtifact(repository.getDatabase(), taskId)!
  return { taskId, artifactId: artifact.id, sha: artifact.contentSha256 }
}

function setState(taskId: string, state: string, planRound?: number): void {
  if (planRound === undefined) {
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = ? WHERE id = ?`)
      .run(state, taskId)
    return
  }
  repository
    .getDatabase()
    .prepare(`UPDATE audited_tasks SET state = ?, plan_round = ? WHERE id = ?`)
    .run(state, planRound, taskId)
}

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  userData = mkdtempSync(join(tmpdir(), 'orca-revision-'))
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
  rmSync(userData, { recursive: true, force: true })
})

describe('requestPlanRevision', () => {
  it('moves plan_fixes_requested -> planning and increments the round', () => {
    const { taskId } = seedReviewableTask()
    setState(taskId, 'plan_fixes_requested', 0)

    expect(requestPlanRevision(repository.getDatabase(), taskId, 2_000)).toEqual({ ok: true })

    const task = repository.getTask(taskId)!
    // A revision is an EXECUTION: it re-enters `planning`, not awaiting_plan_review.
    expect(task.state).toBe('planning')
    expect(task.planRound).toBe(1)

    const row = repository
      .getDatabase()
      .prepare(
        `SELECT actor, to_state FROM audited_transitions WHERE task_id = ? ORDER BY seq DESC`
      )
      .get(taskId) as { actor: string; to_state: string }
    expect(row).toEqual({ actor: 'human', to_state: 'planning' })
  })

  it('refuses at the round cap and writes nothing', () => {
    const { taskId } = seedReviewableTask()
    setState(taskId, 'plan_fixes_requested', 3)

    expect(requestPlanRevision(repository.getDatabase(), taskId, 2_000)).toEqual({
      ok: false,
      reasonCode: 'round_limit_reached'
    })
    const task = repository.getTask(taskId)!
    expect(task.state).toBe('plan_fixes_requested')
    expect(task.planRound).toBe(3)
  })

  it('refuses from any state other than plan_fixes_requested', () => {
    const { taskId } = seedReviewableTask()
    expect(requestPlanRevision(repository.getDatabase(), taskId, 2_000)).toEqual({
      ok: false,
      reasonCode: 'illegal_transition'
    })
  })

  it('is idempotent: the second click finds the task already in planning', () => {
    const { taskId } = seedReviewableTask()
    setState(taskId, 'plan_fixes_requested', 0)
    expect(requestPlanRevision(repository.getDatabase(), taskId, 2_000).ok).toBe(true)
    expect(requestPlanRevision(repository.getDatabase(), taskId, 2_001)).toEqual({
      ok: false,
      reasonCode: 'illegal_transition'
    })
    expect(repository.getTask(taskId)!.planRound).toBe(1)
  })
})

describe('round-3 plans stay reviewable', () => {
  it('admits an audit for a round-3 plan', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    setState(taskId, 'awaiting_plan_review', 3)

    const started = startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 3,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: EXPECTED_IDENTITY,
        auditMode: 'codex_cli' as const
      },
      2_000
    )
    // The cap binds on revision, not on audit — this MUST be admitted.
    expect(started.ok).toBe(true)
  })
})

describe('revision exclusivity', () => {
  it('refuses to admit an audit while a revision is running', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    setState(taskId, 'plan_fixes_requested', 0)
    requestPlanRevision(repository.getDatabase(), taskId, 2_000)
    expect(repository.getTask(taskId)!.state).toBe('planning')

    const started = startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: EXPECTED_IDENTITY,
        auditMode: 'codex_cli' as const
      },
      3_000
    )
    expect(started).toEqual({ ok: false, reasonCode: 'illegal_transition' })
  })
})

describe('plan-review recovery and cancel', () => {
  function startReview(taskId: string, artifactId: string, sha: string): string {
    const started = startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: EXPECTED_IDENTITY,
        auditMode: 'codex_cli' as const
      },
      1_000
    )
    if (!started.ok) {
      throw new Error('start failed')
    }
    return started.runId
  }

  it('marks an interrupted review and blocks the task so Retry is legal', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)

    const recovered = recoverInterruptedPlanReviewRuns(repository.getDatabase(), 5_000)

    expect(recovered).toEqual([{ taskId, runId }])
    const task = repository.getTask(taskId)!
    expect(task.state).toBe('blocked')
    expect(task.preBlockState).toBe('awaiting_plan_review')
    expect(task.blockedReasonCode).toBe('plan_review_process_failed')
  })

  it('recovery is idempotent', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    startReview(taskId, artifactId, sha)
    recoverInterruptedPlanReviewRuns(repository.getDatabase(), 5_000)
    expect(recoverInterruptedPlanReviewRuns(repository.getDatabase(), 6_000)).toEqual([])
  })

  it('recovery skips a task that already moved on', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    startReview(taskId, artifactId, sha)
    setState(taskId, 'ready_to_implement')

    expect(recoverInterruptedPlanReviewRuns(repository.getDatabase(), 5_000)).toEqual([])
    expect(repository.getTask(taskId)!.state).toBe('ready_to_implement')
  })

  it('cancel finalizes the review and leaves the task in awaiting_plan_review', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)

    expect(cancelPlanReviewRun(repository.getDatabase(), { runId, taskId }, 4_000)).toEqual({
      ok: true
    })
    // No state to restore: the task rested here for the whole review.
    expect(repository.getTask(taskId)!.state).toBe('awaiting_plan_review')
  })

  it('a second cancel is refused', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)
    cancelPlanReviewRun(repository.getDatabase(), { runId, taskId }, 4_000)
    expect(cancelPlanReviewRun(repository.getDatabase(), { runId, taskId }, 4_001)).toEqual({
      ok: false,
      reasonCode: 'lock_contended'
    })
  })

  it('a cancelled review frees the task for a new audit', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const runId = startReview(taskId, artifactId, sha)
    cancelPlanReviewRun(repository.getDatabase(), { runId, taskId }, 4_000)

    // The partial unique index only blocks a LIVE review, so a fresh one admits.
    const restarted = startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: EXPECTED_IDENTITY,
        auditMode: 'codex_cli' as const
      },
      5_000
    )
    expect(restarted.ok).toBe(true)
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
