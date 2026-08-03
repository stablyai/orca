// Phase 4 §1. The strand regression: a cancelled DIRECT run must return to
// `ready_to_implement` so Start is legal again — never a stranded `implementing`
// and never a `blocked` detour — and it must get there through the state
// machine's cancelImplementation rule rather than a direct SQL write.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { cancelExecutionRun } from './audited-execution-run-cancel'
import { getExecutionRun, startExecutionRun } from './audited-execution-run-repository'
import { validateAuditedTransition } from './audited-workflow-state-machine'
import {
  seedTriagedTask,
  startRun,
  taskState,
  transitionRows
} from './audited-execution-test-fixtures'

let repository: AuditedTaskRepository

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

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
})

describe('cancelling a direct run', () => {
  it('restores ready_to_implement, and Start is immediately legal again', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    expect(taskState(repository.getDatabase(), taskId)).toBe('implementing')

    const result = cancelExecutionRun(repository.getDatabase(), { runId, taskId }, 200)
    expect(result).toEqual({ ok: true, restoredState: 'ready_to_implement' })
    expect(taskState(repository.getDatabase(), taskId)).toBe('ready_to_implement')

    // The strand proof: a second start must succeed, which it cannot do from
    // `implementing` (startExecution admits only ready_to_implement).
    const restarted = startExecutionRun(
      repository.getDatabase(),
      {
        taskId,
        mode: 'direct',
        preLaunchState: 'ready_to_implement',
        activeRunState: 'implementing',
        worktreeVerifiedAtMs: 10
      },
      300
    )
    expect(restarted.ok).toBe(true)
  })

  it('never routes through blocked', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    cancelExecutionRun(repository.getDatabase(), { runId, taskId }, 200)

    const states = transitionRows(repository.getDatabase(), taskId).map((r) => r.to_state)
    expect(states).not.toContain('blocked')
  })

  it('records a truthful history row through the state machine', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    cancelExecutionRun(repository.getDatabase(), { runId, taskId }, 200)

    const rows = transitionRows(repository.getDatabase(), taskId)
    expect(rows.at(-1)).toEqual({
      from_state: 'implementing',
      to_state: 'ready_to_implement',
      actor: 'human',
      event_type: 'execution_cancelled',
      reason_code: 'cancelled_by_user'
    })

    // The write above is only legal because this rule exists — the same check
    // the cancel transaction performs before touching audited_tasks.
    const validation = validateAuditedTransition('cancelImplementation', 'implementing')
    expect(validation.ok).toBe(true)
    if (validation.ok) {
      expect(validation.rule.to).toBe('ready_to_implement')
      expect(validation.rule.actor).toBe('human')
    }
  })

  it('marks the run cancelled with the cancelled_by_user reason', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    cancelExecutionRun(repository.getDatabase(), { runId, taskId }, 200)

    const run = getExecutionRun(repository.getDatabase(), runId)
    expect(run?.status).toBe('cancelled')
    expect(run?.reasonCode).toBe('cancelled_by_user')
    expect(run?.endedAt).toBe(200)
  })
})

describe('cancelling a plan run', () => {
  it('leaves the task in planning and writes a same-state history row', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    const runId = startRun(repository, taskId, 'plan')
    expect(taskState(repository.getDatabase(), taskId)).toBe('planning')

    const result = cancelExecutionRun(repository.getDatabase(), { runId, taskId }, 200)
    expect(result).toEqual({ ok: true, restoredState: 'planning' })
    expect(taskState(repository.getDatabase(), taskId)).toBe('planning')

    // The human action is real history even though `state` did not move.
    expect(transitionRows(repository.getDatabase(), taskId).at(-1)).toEqual({
      from_state: 'planning',
      to_state: 'planning',
      actor: 'human',
      event_type: 'execution_cancelled',
      reason_code: 'cancelled_by_user'
    })
  })

  it('adds no start transition for plan mode (triage already put it in planning)', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    const before = transitionRows(repository.getDatabase(), taskId).length

    startRun(repository, taskId, 'plan')

    // Direct mode writes an execution_started row; plan mode has no state change
    // to record, so the count is unchanged.
    expect(transitionRows(repository.getDatabase(), taskId)).toHaveLength(before)
  })
})

describe('cancel refuses when it is not the authorized writer', () => {
  it('refuses a run that is no longer running', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    cancelExecutionRun(repository.getDatabase(), { runId, taskId }, 200)

    const second = cancelExecutionRun(repository.getDatabase(), { runId, taskId }, 300)
    expect(second).toEqual({ ok: false, reasonCode: 'lock_contended' })
  })

  it('refuses when the task no longer sits in the run active state', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'awaiting_code_audit' WHERE id = ?`)
      .run(taskId)

    expect(cancelExecutionRun(repository.getDatabase(), { runId, taskId }, 200)).toEqual({
      ok: false,
      reasonCode: 'lock_contended'
    })
  })

  it('leaves task state untouched when the run finalize CAS loses', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    // Finalize the run out from under cancel, simulating a concurrent writer.
    repository
      .getDatabase()
      .prepare(`UPDATE audited_execution_runs SET status = 'failed' WHERE id = ?`)
      .run(runId)

    const before = taskState(repository.getDatabase(), taskId)
    expect(cancelExecutionRun(repository.getDatabase(), { runId, taskId }, 200).ok).toBe(false)
    expect(taskState(repository.getDatabase(), taskId)).toBe(before)
  })

  it('refuses an unknown task', () => {
    expect(
      cancelExecutionRun(repository.getDatabase(), { runId: 'exec_x', taskId: 'nope' }, 200)
    ).toEqual({ ok: false, reasonCode: 'task_not_found' })
  })
})
