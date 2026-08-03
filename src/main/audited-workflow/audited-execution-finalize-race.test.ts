// Regression: finalizeExecutionRun must be authorized by BOTH the running
// execution row AND the task still being in that run's recorded activeRunState.
//
// The race it closes: a concurrent writer (startup recovery, an
// invariant-violation block, reconciliation) moves the task to `blocked` while
// the Claude process is still running. The finalize call then arrives holding a
// task-state copy read long before, and without the second check it would
// overwrite that block with a success it has no right to record.
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
  getRunningExecutionRun,
  type FinalizeExecutionRunArgs
} from './audited-execution-run-repository'
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

function successArgs(
  runId: string,
  taskId: string,
  mode: 'plan' | 'direct'
): FinalizeExecutionRunArgs {
  return {
    runId,
    taskId,
    status: 'succeeded',
    reasonCode: null,
    toState: mode === 'plan' ? 'awaiting_plan_review' : 'awaiting_code_audit',
    blockedReasonCode: null,
    preBlockState: null,
    blockedPhase: null,
    eventType: mode === 'plan' ? 'plan_complete' : 'implement_complete',
    counters: { stdoutBytes: 3, stderrBytes: 0, outputTruncated: false, exitCode: 0 }
  }
}

/** Simulates a concurrent writer blocking the task mid-run. */
function concurrentlyBlock(taskId: string, preBlockState: string): void {
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks
          SET state = 'blocked', pre_block_state = ?, blocked_reason_code = 'implement_process_failed',
              blocked_phase = 'execution'
        WHERE id = ?`
    )
    .run(preBlockState, taskId)
}

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
})

describe('a task blocked mid-run cannot be finalized over', () => {
  it.each(['plan', 'direct'] as const)(
    '%s mode: returns contention and preserves BOTH the block and the running run',
    (mode) => {
      const taskId = makeTask()
      seedTriagedTask(repository, taskId, mode)
      const runId = startRun(repository, taskId, mode)
      concurrentlyBlock(taskId, mode === 'plan' ? 'planning' : 'implementing')

      const result = finalizeExecutionRun(
        repository.getDatabase(),
        successArgs(runId, taskId, mode),
        400
      )

      expect(result).toEqual({ ok: false, reasonCode: 'lock_contended' })
      // The block survives untouched.
      const task = repository.getTask(taskId)
      expect(task?.state).toBe('blocked')
      expect(task?.blockedReasonCode).toBe('implement_process_failed')
      // EVERY write rolled back, including the execution-run update — the run is
      // still `running`, so startup recovery can classify it honestly.
      const run = getExecutionRun(repository.getDatabase(), runId)
      expect(run?.status).toBe('running')
      expect(run?.reasonCode).toBeNull()
      expect(run?.endedAt).toBeNull()
      expect(getRunningExecutionRun(repository.getDatabase(), taskId)).not.toBeNull()
    }
  )

  it('writes no transition row when contended', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    const before = transitionRows(repository.getDatabase(), taskId).length
    concurrentlyBlock(taskId, 'implementing')

    finalizeExecutionRun(repository.getDatabase(), successArgs(runId, taskId, 'direct'), 400)

    expect(transitionRows(repository.getDatabase(), taskId)).toHaveLength(before)
  })

  it('refuses a blocking finalize too, so a concurrent block is never overwritten', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    concurrentlyBlock(taskId, 'implementing')

    const result = finalizeExecutionRun(
      repository.getDatabase(),
      {
        runId,
        taskId,
        status: 'failed',
        reasonCode: 'timeout',
        toState: 'blocked',
        blockedReasonCode: 'agent_timeout',
        preBlockState: 'implementing',
        blockedPhase: 'execution',
        eventType: 'execution_blocked',
        counters: { stdoutBytes: 0, stderrBytes: 0, outputTruncated: false, exitCode: null }
      },
      400
    )

    expect(result).toEqual({ ok: false, reasonCode: 'lock_contended' })
    // The FIRST writer's reason wins; this call does not clobber it.
    expect(repository.getTask(taskId)?.blockedReasonCode).toBe('implement_process_failed')
    expect(getExecutionRun(repository.getDatabase(), runId)?.status).toBe('running')
  })

  it('refuses when the task advanced rather than blocked', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'awaiting_code_audit' WHERE id = ?`)
      .run(taskId)

    expect(
      finalizeExecutionRun(repository.getDatabase(), successArgs(runId, taskId, 'direct'), 400)
    ).toEqual({ ok: false, reasonCode: 'lock_contended' })
    expect(getExecutionRun(repository.getDatabase(), runId)?.status).toBe('running')
  })
})

describe('normal finalization still succeeds', () => {
  it.each([
    ['plan', 'awaiting_plan_review'],
    ['direct', 'awaiting_code_audit']
  ] as const)('%s mode advances to %s', (mode, expected) => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, mode)
    const runId = startRun(repository, taskId, mode)

    const result = finalizeExecutionRun(
      repository.getDatabase(),
      successArgs(runId, taskId, mode),
      400
    )

    expect(result.ok).toBe(true)
    expect(taskState(repository.getDatabase(), taskId)).toBe(expected)
    expect(getExecutionRun(repository.getDatabase(), runId)?.status).toBe('succeeded')
  })

  it('blocking finalization from the live run state still succeeds', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    const runId = startRun(repository, taskId, 'plan')

    const result = finalizeExecutionRun(
      repository.getDatabase(),
      {
        runId,
        taskId,
        status: 'failed',
        reasonCode: 'empty_output',
        toState: 'blocked',
        blockedReasonCode: 'plan_output_empty',
        preBlockState: 'planning',
        blockedPhase: 'execution',
        eventType: 'execution_blocked',
        counters: { stdoutBytes: 0, stderrBytes: 0, outputTruncated: false, exitCode: 0 }
      },
      400
    )

    expect(result.ok).toBe(true)
    expect(repository.getTask(taskId)?.state).toBe('blocked')
    expect(repository.getTask(taskId)?.preBlockState).toBe('planning')
  })

  it('a null toState leaves the task alone but still finalizes the run', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    const runId = startRun(repository, taskId, 'plan')

    const result = finalizeExecutionRun(
      repository.getDatabase(),
      {
        runId,
        taskId,
        status: 'cancelled',
        reasonCode: 'cancelled_by_user',
        toState: null,
        blockedReasonCode: null,
        preBlockState: null,
        blockedPhase: null,
        eventType: 'execution_cancelled',
        counters: { stdoutBytes: 0, stderrBytes: 0, outputTruncated: false, exitCode: null }
      },
      400
    )

    expect(result.ok).toBe(true)
    expect(taskState(repository.getDatabase(), taskId)).toBe('planning')
    expect(getExecutionRun(repository.getDatabase(), runId)?.status).toBe('cancelled')
  })
})

describe('no invalid transition can be written by this path', () => {
  it.each([
    // plan run lives in `planning`; awaiting_code_audit is not reachable from it
    ['plan', 'awaiting_code_audit'],
    // direct run lives in `implementing`; awaiting_plan_review is not reachable
    ['direct', 'awaiting_plan_review'],
    // neither lane may jump straight to a commit/landing state
    ['direct', 'committing'],
    ['plan', 'landed'],
    ['direct', 'ready_to_implement']
  ] as const)('%s mode refuses a finalize to %s', (mode, toState) => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, mode)
    const runId = startRun(repository, taskId, mode)
    const before = taskState(repository.getDatabase(), taskId)

    const result = finalizeExecutionRun(
      repository.getDatabase(),
      { ...successArgs(runId, taskId, mode), toState },
      400
    )

    expect(result).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    // Nothing written: state unchanged and the run left running.
    expect(taskState(repository.getDatabase(), taskId)).toBe(before)
    expect(getExecutionRun(repository.getDatabase(), runId)?.status).toBe('running')
  })

  it('the mismatch is caught even though the raw SQL UPDATE would have accepted it', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    const runId = startRun(repository, taskId, 'plan')

    // Proof the guard is the state machine, not the schema: the CHECK constraint
    // happily accepts this value when written directly, so only the validation
    // added to finalizeExecutionRun prevents it.
    expect(() =>
      repository
        .getDatabase()
        .prepare(`UPDATE audited_tasks SET state = 'awaiting_code_audit' WHERE id = ?`)
        .run(taskId)
    ).not.toThrow()
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'planning' WHERE id = ?`)
      .run(taskId)

    expect(
      finalizeExecutionRun(
        repository.getDatabase(),
        { ...successArgs(runId, taskId, 'plan'), toState: 'awaiting_code_audit' },
        400
      )
    ).toEqual({ ok: false, reasonCode: 'illegal_transition' })
  })
})
