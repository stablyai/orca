// Phase 4 run-state bookkeeping. pre_launch_state and active_run_state are
// RECORDED at start, never inferred from the mode at read time — that is what
// lets cancel restore the exact pre-launch state and lets failure write the
// correct pre_block_state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { cancelExecutionRun } from './audited-execution-run-cancel'
import {
  finalizeExecutionRun,
  getExecutionRun,
  getRunningExecutionRun
} from './audited-execution-run-repository'
import { seedTriagedTask, startRun, taskState } from './audited-execution-test-fixtures'

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

describe('recorded at start', () => {
  it('plan mode records planning for both', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    startRun(repository, taskId, 'plan')

    const run = getRunningExecutionRun(repository.getDatabase(), taskId)
    expect(run?.preLaunchState).toBe('planning')
    expect(run?.activeRunState).toBe('planning')
  })

  it('direct mode records the two DIFFERENT states', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    startRun(repository, taskId, 'direct')

    const run = getRunningExecutionRun(repository.getDatabase(), taskId)
    expect(run?.preLaunchState).toBe('ready_to_implement')
    expect(run?.activeRunState).toBe('implementing')
    expect(run?.preLaunchState).not.toBe(run?.activeRunState)
  })

  it('records the worktree verification timestamp as proof it preceded launch', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    startRun(repository, taskId, 'plan')

    expect(getRunningExecutionRun(repository.getDatabase(), taskId)?.worktreeVerifiedAt).toBe(10)
  })
})

describe('failure writes active_run_state to pre_block_state', () => {
  it.each([
    ['plan', 'planning'],
    ['direct', 'implementing']
  ] as const)('%s mode blocks with pre_block_state=%s', (mode, expected) => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, mode)
    const runId = startRun(repository, taskId, mode)
    const run = getExecutionRun(repository.getDatabase(), runId)

    finalizeExecutionRun(
      repository.getDatabase(),
      {
        runId,
        taskId,
        status: 'failed',
        reasonCode: 'exit_nonzero',
        toState: 'blocked',
        blockedReasonCode: 'implement_process_failed',
        preBlockState: run?.activeRunState ?? null,
        blockedPhase: 'execution',
        eventType: 'execution_blocked',
        counters: { stdoutBytes: 0, stderrBytes: 0, outputTruncated: false, exitCode: 1 }
      },
      200
    )

    expect(repository.getTask(taskId)?.preBlockState).toBe(expected)
  })
})

describe('cancel reads pre_launch_state, never the mode', () => {
  it('restores what the row says even if the row disagrees with the mode default', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')

    cancelExecutionRun(repository.getDatabase(), { runId, taskId }, 200)

    expect(taskState(repository.getDatabase(), taskId)).toBe(
      getExecutionRun(repository.getDatabase(), runId)?.preLaunchState
    )
  })
})

describe('the running-row invariant is scoped to start/retry only', () => {
  it('an idle task in a resting state legitimately has no running row', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')

    expect(taskState(repository.getDatabase(), taskId)).toBe('ready_to_implement')
    expect(getRunningExecutionRun(repository.getDatabase(), taskId)).toBeNull()
  })

  it('a cancelled run leaves no running row and that is valid', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    cancelExecutionRun(repository.getDatabase(), { runId, taskId }, 200)

    expect(getRunningExecutionRun(repository.getDatabase(), taskId)).toBeNull()
    expect(taskState(repository.getDatabase(), taskId)).toBe('ready_to_implement')
  })

  it('a blocked task never has a running row', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')
    finalizeExecutionRun(
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
      200
    )

    expect(taskState(repository.getDatabase(), taskId)).toBe('blocked')
    expect(getRunningExecutionRun(repository.getDatabase(), taskId)).toBeNull()
  })

  it('while implementing, a running row always exists', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    startRun(repository, taskId, 'direct')

    expect(taskState(repository.getDatabase(), taskId)).toBe('implementing')
    expect(getRunningExecutionRun(repository.getDatabase(), taskId)).not.toBeNull()
  })
})
