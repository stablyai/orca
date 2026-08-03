// Phase 4 persistence + CAS. The invariant under test: a successful start never
// leaves a task in its active execution state without inserting that run's
// `running` row in the SAME transaction.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import {
  finalizeExecutionRun,
  getExecutionRun,
  getLatestExecutionRun,
  getRunningExecutionRun,
  startExecutionRun
} from './audited-execution-run-repository'
import {
  executionRunCount,
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

describe('startExecutionRun', () => {
  it('writes the running row and the state change together for direct mode', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')

    const started = startExecutionRun(
      repository.getDatabase(),
      {
        taskId,
        mode: 'direct',
        preLaunchState: 'ready_to_implement',
        activeRunState: 'implementing',
        worktreeVerifiedAtMs: 10
      },
      100
    )

    expect(started.ok).toBe(true)
    expect(taskState(repository.getDatabase(), taskId)).toBe('implementing')
    const run = getRunningExecutionRun(repository.getDatabase(), taskId)
    expect(run?.mode).toBe('direct')
    expect(run?.preLaunchState).toBe('ready_to_implement')
    expect(run?.activeRunState).toBe('implementing')
    expect(run?.worktreeVerifiedAt).toBe(10)
  })

  it('does not move task state for plan mode (triage already put it in planning)', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')

    startRun(repository, taskId, 'plan')

    expect(taskState(repository.getDatabase(), taskId)).toBe('planning')
    const run = getRunningExecutionRun(repository.getDatabase(), taskId)
    expect(run?.preLaunchState).toBe('planning')
    expect(run?.activeRunState).toBe('planning')
  })

  it('refuses a duplicate start with lock_contended and creates no second row', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    startRun(repository, taskId, 'plan')

    const second = startExecutionRun(
      repository.getDatabase(),
      {
        taskId,
        mode: 'plan',
        preLaunchState: 'planning',
        activeRunState: 'planning',
        worktreeVerifiedAtMs: 10
      },
      101
    )

    expect(second).toEqual({ ok: false, reasonCode: 'lock_contended' })
    expect(executionRunCount(repository.getDatabase(), taskId)).toBe(1)
  })

  it('refuses a start from the wrong state', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'planning' WHERE id = ?`)
      .run(taskId)

    expect(
      startExecutionRun(
        repository.getDatabase(),
        {
          taskId,
          mode: 'direct',
          preLaunchState: 'ready_to_implement',
          activeRunState: 'implementing',
          worktreeVerifiedAtMs: 10
        },
        100
      )
    ).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    expect(executionRunCount(repository.getDatabase(), taskId)).toBe(0)
  })

  it('refuses an unknown task', () => {
    expect(
      startExecutionRun(
        repository.getDatabase(),
        {
          taskId: 'nope',
          mode: 'plan',
          preLaunchState: 'planning',
          activeRunState: 'planning',
          worktreeVerifiedAtMs: 10
        },
        100
      )
    ).toEqual({ ok: false, reasonCode: 'task_not_found' })
  })
})

describe('finalizeExecutionRun', () => {
  it('advances the task and records the event on success', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')

    const result = finalizeExecutionRun(
      repository.getDatabase(),
      {
        runId,
        taskId,
        status: 'succeeded',
        reasonCode: null,
        toState: 'awaiting_code_audit',
        blockedReasonCode: null,
        preBlockState: null,
        blockedPhase: null,
        eventType: 'implement_complete',
        counters: { stdoutBytes: 4, stderrBytes: 0, outputTruncated: false, exitCode: 0 }
      },
      200
    )

    expect(result.ok).toBe(true)
    expect(taskState(repository.getDatabase(), taskId)).toBe('awaiting_code_audit')
    const run = getExecutionRun(repository.getDatabase(), runId)
    expect(run?.status).toBe('succeeded')
    expect(run?.stdoutBytes).toBe(4)
    expect(transitionRows(repository.getDatabase(), taskId).at(-1)?.event_type).toBe(
      'implement_complete'
    )
  })

  it('refuses a non-running row and leaves task state untouched', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    repository
      .getDatabase()
      .prepare(`UPDATE audited_execution_runs SET status = 'cancelled' WHERE id = ?`)
      .run(runId)

    const before = taskState(repository.getDatabase(), taskId)
    const result = finalizeExecutionRun(
      repository.getDatabase(),
      {
        runId,
        taskId,
        status: 'succeeded',
        reasonCode: null,
        toState: 'awaiting_code_audit',
        blockedReasonCode: null,
        preBlockState: null,
        blockedPhase: null,
        eventType: 'implement_complete',
        counters: { stdoutBytes: 0, stderrBytes: 0, outputTruncated: false, exitCode: 0 }
      },
      200
    )

    expect(result).toEqual({ ok: false, reasonCode: 'lock_contended' })
    expect(taskState(repository.getDatabase(), taskId)).toBe(before)
  })

  it('records the block with pre_block_state so retry is legal', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')

    finalizeExecutionRun(
      repository.getDatabase(),
      {
        runId,
        taskId,
        status: 'failed',
        reasonCode: 'exit_nonzero',
        toState: 'blocked',
        blockedReasonCode: 'implement_process_failed',
        preBlockState: 'implementing',
        blockedPhase: 'execution',
        eventType: 'execution_blocked',
        counters: { stdoutBytes: 0, stderrBytes: 2, outputTruncated: false, exitCode: 3 }
      },
      200
    )

    const task = repository.getTask(taskId)
    expect(task?.state).toBe('blocked')
    expect(task?.preBlockState).toBe('implementing')
    expect(getExecutionRun(repository.getDatabase(), runId)?.exitCode).toBe(3)
  })
})

describe('getLatestExecutionRun', () => {
  it('returns the most recently started run', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    const first = startRun(repository, taskId, 'plan')
    finalizeExecutionRun(
      repository.getDatabase(),
      {
        runId: first,
        taskId,
        status: 'failed',
        reasonCode: 'timeout',
        toState: null,
        blockedReasonCode: null,
        preBlockState: null,
        blockedPhase: null,
        eventType: 'execution_blocked',
        counters: { stdoutBytes: 0, stderrBytes: 0, outputTruncated: false, exitCode: null }
      },
      200
    )
    const second = startRun(repository, taskId, 'plan')

    expect(getLatestExecutionRun(repository.getDatabase(), taskId)?.id).toBe(second)
  })
})
