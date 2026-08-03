// Phase 4 crash recovery. A `running` row cannot be assumed alive after a
// restart, and no PID is ever consulted: PID reuse makes liveness unanswerable,
// and a wrong answer is worse than an honest `interrupted`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { recoverInterruptedExecutionRuns } from './audited-execution-run-recovery'
import { getExecutionRun } from './audited-execution-run-repository'
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

describe('recoverInterruptedExecutionRuns', () => {
  it('marks a running row interrupted and blocks the task with pre_block_state', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    const runId = startRun(repository, taskId, 'direct')

    const recovered = recoverInterruptedExecutionRuns(repository.getDatabase(), 500)

    expect(recovered).toEqual([{ taskId, runId }])
    const run = getExecutionRun(repository.getDatabase(), runId)
    expect(run?.status).toBe('interrupted')
    expect(run?.reasonCode).toBe('interrupted')
    const task = repository.getTask(taskId)
    expect(task?.state).toBe('blocked')
    expect(task?.preBlockState).toBe('implementing')
    expect(task?.blockedPhase).toBe('execution')
  })

  it('records the true prior state in history, never a fabricated outcome', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    startRun(repository, taskId, 'plan')

    recoverInterruptedExecutionRuns(repository.getDatabase(), 500)

    expect(transitionRows(repository.getDatabase(), taskId).at(-1)).toEqual({
      from_state: 'planning',
      to_state: 'blocked',
      actor: 'control',
      event_type: 'execution_interrupted',
      reason_code: 'interrupted'
    })
  })

  it('is idempotent — a second pass finds nothing left to do', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    startRun(repository, taskId, 'direct')

    expect(recoverInterruptedExecutionRuns(repository.getDatabase(), 500)).toHaveLength(1)
    expect(recoverInterruptedExecutionRuns(repository.getDatabase(), 600)).toHaveLength(0)
  })

  it('skips a task that already moved on, without writing', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    startRun(repository, taskId, 'direct')
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'awaiting_code_audit' WHERE id = ?`)
      .run(taskId)

    expect(recoverInterruptedExecutionRuns(repository.getDatabase(), 500)).toHaveLength(0)
    expect(taskState(repository.getDatabase(), taskId)).toBe('awaiting_code_audit')
  })

  it('leaves already-terminal runs alone', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    const runId = startRun(repository, taskId, 'plan')
    repository
      .getDatabase()
      .prepare(`UPDATE audited_execution_runs SET status = 'succeeded' WHERE id = ?`)
      .run(runId)

    expect(recoverInterruptedExecutionRuns(repository.getDatabase(), 500)).toHaveLength(0)
    expect(getExecutionRun(repository.getDatabase(), runId)?.status).toBe('succeeded')
  })

  it('never reads a pid column — the table has none', () => {
    const columns = repository
      .getDatabase()
      .prepare(`PRAGMA table_info(audited_execution_runs)`)
      .all() as { name: string }[]
    expect(columns.map((c) => c.name)).not.toContain('pid')
  })
})
