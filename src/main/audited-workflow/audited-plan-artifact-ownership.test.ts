// THE DERIVATION OWNERSHIP CONTRACT (plan §3.1).
//
// The artifact file is written OUTSIDE any transaction, so between its atomic
// rename and the attach transaction a cancel, a startup recovery, or an
// invariant block can legitimately take the task. These tests prove the LOSING
// derivation cannot overwrite the winner: no artifact row, no pointer, no task
// write, no transition — and the winner's recorded outcome is byte-identical to
// what it was before the losing call.
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
import { seedTriagedTask, startRun } from './audited-execution-test-fixtures'

let repository: AuditedTaskRepository
let userData: string

const COUNTERS = { stdoutBytes: 10, stderrBytes: 0, outputTruncated: false, exitCode: 0 }

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

/** A task mid plan-run: state `planning` with a live execution row. */
function seedRunningPlan(): { taskId: string; runId: string } {
  const taskId = makeTask()
  seedTriagedTask(repository, taskId, 'plan')
  const runId = startRun(repository, taskId, 'plan')
  return { taskId, runId }
}

function derive(taskId: string, runId: string) {
  return derivePlanArtifact(
    repository.getDatabase(),
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

function artifactCount(taskId: string): number {
  const row = repository
    .getDatabase()
    .prepare(`SELECT COUNT(*) as n FROM audited_plan_artifacts WHERE task_id = ?`)
    .get(taskId) as { n: number }
  return row.n
}

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  userData = mkdtempSync(join(tmpdir(), 'orca-ownership-'))
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
  rmSync(userData, { recursive: true, force: true })
})

describe('derivePlanArtifact — happy path', () => {
  it('attaches the artifact, advances the task, and completes the run in one commit', () => {
    const { taskId, runId } = seedRunningPlan()
    const result = derive(taskId, runId)

    expect(result.ok).toBe(true)
    const task = repository.getTask(taskId)!
    expect(task.state).toBe('awaiting_plan_review')
    expect(task.currentPlanArtifactId).not.toBeNull()

    const artifact = getCurrentPlanArtifact(repository.getDatabase(), taskId)!
    expect(artifact.status).toBe('current')
    expect(artifact.runId).toBe(runId)
    expect(task.currentPlanArtifactId).toBe(artifact.id)

    const run = repository
      .getDatabase()
      .prepare(`SELECT status FROM audited_execution_runs WHERE id = ?`)
      .get(runId) as { status: string }
    expect(run.status).toBe('succeeded')
  })

  it('refuses a second artifact for the same run (UNIQUE(run_id))', () => {
    const { taskId, runId } = seedRunningPlan()
    expect(derive(taskId, runId).ok).toBe(true)

    // Put the task back so only the run-id uniqueness can refuse the second call.
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'planning' WHERE id = ?`)
      .run(taskId)
    repository
      .getDatabase()
      .prepare(`UPDATE audited_execution_runs SET status = 'running' WHERE id = ?`)
      .run(runId)

    const second = derive(taskId, runId)
    expect(second).toMatchObject({ ok: false, kind: 'not_owner' })
    expect(artifactCount(taskId)).toBe(1)
  })
})

describe('derivation ownership races', () => {
  it('cancel wins: a derivation that lost the run writes nothing', () => {
    const { taskId, runId } = seedRunningPlan()

    // The cancel lands after the artifact file was renamed but before attach.
    repository
      .getDatabase()
      .prepare(
        `UPDATE audited_execution_runs SET status = 'cancelled', reason_code = 'cancelled_by_user' WHERE id = ?`
      )
      .run(runId)
    const before = snapshotTask(taskId)
    const transitionsBefore = transitionCount(taskId)

    const result = derive(taskId, runId)

    expect(result).toMatchObject({ ok: false, kind: 'not_owner' })
    expect(artifactCount(taskId)).toBe(0)
    expect(snapshotTask(taskId)).toEqual(before)
    expect(transitionCount(taskId)).toBe(transitionsBefore)

    // The winner's outcome is intact.
    const run = repository
      .getDatabase()
      .prepare(`SELECT status, reason_code FROM audited_execution_runs WHERE id = ?`)
      .get(runId) as { status: string; reason_code: string }
    expect(run).toEqual({ status: 'cancelled', reason_code: 'cancelled_by_user' })
  })

  it('startup recovery wins: a derivation that lost the task state writes nothing', () => {
    const { taskId, runId } = seedRunningPlan()

    // Recovery blocked the task and marked the run interrupted.
    repository
      .getDatabase()
      .prepare(
        `UPDATE audited_execution_runs SET status = 'interrupted', reason_code = 'interrupted' WHERE id = ?`
      )
      .run(runId)
    repository
      .getDatabase()
      .prepare(
        `UPDATE audited_tasks SET state = 'blocked', pre_block_state = 'planning',
           blocked_reason_code = 'plan_process_failed' WHERE id = ?`
      )
      .run(taskId)
    const before = snapshotTask(taskId)
    const transitionsBefore = transitionCount(taskId)

    const result = derive(taskId, runId)

    expect(result).toMatchObject({ ok: false, kind: 'not_owner' })
    expect(artifactCount(taskId)).toBe(0)
    expect(snapshotTask(taskId)).toEqual(before)
    expect(transitionCount(taskId)).toBe(transitionsBefore)
  })

  it('an invariant block wins even while the run is still running', () => {
    const { taskId, runId } = seedRunningPlan()

    // The run row is untouched (check 1 passes) but the task moved (check 2 fails).
    repository
      .getDatabase()
      .prepare(
        `UPDATE audited_tasks SET state = 'blocked', pre_block_state = 'planning',
           blocked_reason_code = 'worktree_drift_detected' WHERE id = ?`
      )
      .run(taskId)
    const before = snapshotTask(taskId)

    const result = derive(taskId, runId)

    expect(result).toMatchObject({ ok: false, kind: 'not_owner' })
    expect(artifactCount(taskId)).toBe(0)
    expect(snapshotTask(taskId)).toEqual(before)
    // The run is left `running` for startup recovery to classify honestly,
    // rather than being given an outcome this call did not earn.
    const run = repository
      .getDatabase()
      .prepare(`SELECT status FROM audited_execution_runs WHERE id = ?`)
      .get(runId) as { status: string }
    expect(run.status).toBe('running')
  })

  it('blocks rather than advancing when the plan is empty after sanitization', () => {
    const { taskId, runId } = seedRunningPlan()
    const result = derivePlanArtifact(
      repository.getDatabase(),
      userData,
      {
        taskId,
        runId,
        round: 0,
        rawPlanText: '   \n[0m  ',
        sanitizationContext: {},
        counters: COUNTERS
      },
      1_000
    )

    expect(result).toMatchObject({ ok: false, kind: 'empty' })
    expect(artifactCount(taskId)).toBe(0)
    // Critically: the task must NOT have advanced to awaiting_plan_review.
    expect(repository.getTask(taskId)!.state).toBe('planning')
    expect(repository.getTask(taskId)!.currentPlanArtifactId).toBeNull()
  })
})

describe('artifact supersession', () => {
  it('supersedes the prior current artifact and repoints the task', () => {
    const first = seedRunningPlan()
    expect(derive(first.taskId, first.runId).ok).toBe(true)
    const firstArtifact = getCurrentPlanArtifact(repository.getDatabase(), first.taskId)!

    // A revision: back to planning, new run.
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'planning', plan_round = 1 WHERE id = ?`)
      .run(first.taskId)
    const secondRun = startRun(repository, first.taskId, 'plan')
    expect(derive(first.taskId, secondRun).ok).toBe(true)

    const secondArtifact = getCurrentPlanArtifact(repository.getDatabase(), first.taskId)!
    expect(secondArtifact.id).not.toBe(firstArtifact.id)
    expect(repository.getTask(first.taskId)!.currentPlanArtifactId).toBe(secondArtifact.id)

    // History is retained, not deleted.
    const old = repository
      .getDatabase()
      .prepare(`SELECT status, superseded_by FROM audited_plan_artifacts WHERE id = ?`)
      .get(firstArtifact.id) as { status: string; superseded_by: string }
    expect(old.status).toBe('superseded')
    expect(old.superseded_by).toBe(secondArtifact.id)
  })
})
