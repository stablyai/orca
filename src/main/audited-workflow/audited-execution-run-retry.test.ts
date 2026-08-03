// Phase 4 §2. Retry ordering and atomicity: the read-only preflight runs BEFORE
// the transaction opens, so a drifted worktree can never produce a `running`
// row, a state change, or a transition — and the reason returned is the fresh
// one, never a stored column.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { verifyWorktreeForTaskMock, ensureWorktreeForTaskMock, runAuditedClaudeMock } = vi.hoisted(
  () => ({
    verifyWorktreeForTaskMock: vi.fn(),
    ensureWorktreeForTaskMock: vi.fn(),
    runAuditedClaudeMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

vi.mock('./audited-worktree-service', () => ({
  verifyWorktreeForTask: verifyWorktreeForTaskMock,
  ensureWorktreeForTask: ensureWorktreeForTaskMock,
  setAuditedWorktreeStore: vi.fn()
}))

vi.mock('./audited-execution-launcher', () => ({ runAuditedClaude: runAuditedClaudeMock }))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { retryExecution } from './audited-execution-orchestration'
import { retryExecutionRun } from './audited-execution-run-retry'
import { finalizeExecutionRun, getRunningExecutionRun } from './audited-execution-run-repository'
import {
  executionRunCount,
  seedTriagedTask,
  seedTriageRun,
  startRun,
  taskState,
  transitionRows
} from './audited-execution-test-fixtures'
import type { ExecutionReasonCode } from '../../shared/audited-execution-types'

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

/** Runs a task to a terminal, execution-blocked state with the given reason. */
function blockWithReason(
  taskId: string,
  mode: 'plan' | 'direct',
  reason: ExecutionReasonCode
): void {
  seedTriagedTask(repository, taskId, mode)
  const runId = startRun(repository, taskId, mode)
  const activeRunState = mode === 'plan' ? 'planning' : 'implementing'
  finalizeExecutionRun(
    repository.getDatabase(),
    {
      runId,
      taskId,
      status: 'failed',
      reasonCode: reason,
      toState: 'blocked',
      blockedReasonCode: 'implement_process_failed',
      preBlockState: activeRunState,
      blockedPhase: 'execution',
      eventType: 'execution_blocked',
      counters: { stdoutBytes: 0, stderrBytes: 0, outputTruncated: false, exitCode: 1 }
    },
    200
  )
  // Worktree identity so the orchestration path can proceed past its reads.
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks SET worktree_path = '/tmp/wt', branch_name = 'b',
              worktree_provenance = 'orca_audited_v1' WHERE id = ?`
    )
    .run(taskId)
}

beforeEach(() => {
  verifyWorktreeForTaskMock.mockReset()
  ensureWorktreeForTaskMock.mockReset()
  runAuditedClaudeMock.mockReset()
  runAuditedClaudeMock.mockResolvedValue({ kind: 'exit', exitCode: 0, stdout: 'ok', stderr: '' })
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
})

describe('retry preflight failure changes nothing', () => {
  it('creates no run row, no state change, and no transition', async () => {
    const taskId = makeTask()
    blockWithReason(taskId, 'direct', 'exit_nonzero')
    verifyWorktreeForTaskMock.mockResolvedValue({
      ok: false,
      reasonCode: 'head_moved_from_base_commit'
    })

    const runsBefore = executionRunCount(repository.getDatabase(), taskId)
    const transitionsBefore = transitionRows(repository.getDatabase(), taskId).length
    const rowBefore = repository
      .getDatabase()
      .prepare(`SELECT * FROM audited_tasks WHERE id = ?`)
      .get(taskId)

    const result = await retryExecution(taskId)

    expect(result).toEqual({
      ok: false,
      kind: 'worktree',
      reasonCode: 'head_moved_from_base_commit',
      persisted: false
    })
    expect(executionRunCount(repository.getDatabase(), taskId)).toBe(runsBefore)
    expect(transitionRows(repository.getDatabase(), taskId)).toHaveLength(transitionsBefore)
    expect(
      repository.getDatabase().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(taskId)
    ).toEqual(rowBefore)
  })

  it('leaves the task blocked with worktreeReasonCode still null', async () => {
    const taskId = makeTask()
    blockWithReason(taskId, 'direct', 'exit_nonzero')
    verifyWorktreeForTaskMock.mockResolvedValue({ ok: false, reasonCode: 'worktree_missing' })

    await retryExecution(taskId)

    const task = repository.getTask(taskId)
    expect(task?.state).toBe('blocked')
    expect(task?.worktreeReasonCode).toBeNull()
  })

  it('never spawns a process', async () => {
    const taskId = makeTask()
    blockWithReason(taskId, 'direct', 'exit_nonzero')
    verifyWorktreeForTaskMock.mockResolvedValue({ ok: false, reasonCode: 'worktree_missing' })

    await retryExecution(taskId)

    expect(runAuditedClaudeMock).not.toHaveBeenCalled()
  })

  it('uses the read-only preflight, never the provisioning entry point', async () => {
    const taskId = makeTask()
    blockWithReason(taskId, 'direct', 'exit_nonzero')
    verifyWorktreeForTaskMock.mockResolvedValue({ ok: false, reasonCode: 'worktree_missing' })

    await retryExecution(taskId)

    expect(verifyWorktreeForTaskMock).toHaveBeenCalledWith(taskId)
    expect(ensureWorktreeForTaskMock).not.toHaveBeenCalled()
  })
})

describe('retry transaction', () => {
  it('unblocks and inserts exactly one running row', () => {
    const taskId = makeTask()
    blockWithReason(taskId, 'direct', 'exit_nonzero')

    const result = retryExecutionRun(
      repository.getDatabase(),
      { taskId, worktreeVerifiedAtMs: 1 },
      300
    )

    expect(result.ok).toBe(true)
    expect(taskState(repository.getDatabase(), taskId)).toBe('implementing')
    expect(getRunningExecutionRun(repository.getDatabase(), taskId)).not.toBeNull()
    expect(executionRunCount(repository.getDatabase(), taskId)).toBe(2)
  })

  it('resumes planning vs implementing from pre_block_state', () => {
    const planTask = makeTask()
    blockWithReason(planTask, 'plan', 'empty_output')
    retryExecutionRun(repository.getDatabase(), { taskId: planTask, worktreeVerifiedAtMs: 1 }, 300)
    expect(taskState(repository.getDatabase(), planTask)).toBe('planning')

    const directTask = makeTask()
    blockWithReason(directTask, 'direct', 'exit_nonzero')
    retryExecutionRun(
      repository.getDatabase(),
      { taskId: directTask, worktreeVerifiedAtMs: 1 },
      300
    )
    expect(taskState(repository.getDatabase(), directTask)).toBe('implementing')
  })

  it('writes an execution_retried row carrying the prior reason', () => {
    const taskId = makeTask()
    blockWithReason(taskId, 'direct', 'timeout')
    retryExecutionRun(repository.getDatabase(), { taskId, worktreeVerifiedAtMs: 1 }, 300)

    expect(transitionRows(repository.getDatabase(), taskId).at(-1)).toEqual({
      from_state: 'blocked',
      to_state: 'implementing',
      actor: 'human',
      event_type: 'execution_retried',
      reason_code: 'timeout'
    })
  })

  it('carries pre_launch_state forward so a later cancel still restores correctly', () => {
    const taskId = makeTask()
    blockWithReason(taskId, 'direct', 'exit_nonzero')
    retryExecutionRun(repository.getDatabase(), { taskId, worktreeVerifiedAtMs: 1 }, 300)

    const run = getRunningExecutionRun(repository.getDatabase(), taskId)
    expect(run?.preLaunchState).toBe('ready_to_implement')
    expect(run?.activeRunState).toBe('implementing')
  })

  it('a concurrent double retry produces exactly one running row', () => {
    const taskId = makeTask()
    blockWithReason(taskId, 'direct', 'exit_nonzero')

    const first = retryExecutionRun(
      repository.getDatabase(),
      { taskId, worktreeVerifiedAtMs: 1 },
      300
    )
    const second = retryExecutionRun(
      repository.getDatabase(),
      { taskId, worktreeVerifiedAtMs: 1 },
      301
    )

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    const running = repository
      .getDatabase()
      .prepare(
        `SELECT COUNT(*) AS n FROM audited_execution_runs WHERE task_id = ? AND status = 'running'`
      )
      .get(taskId) as { n: number }
    expect(running.n).toBe(1)
  })
})

describe('the retryable set is enforced server-side', () => {
  it.each(['unexpected_commit_detected', 'output_too_large', 'cancelled_by_user'] as const)(
    'refuses %s even though the block looks retryable',
    (reason) => {
      const taskId = makeTask()
      blockWithReason(taskId, 'direct', reason)

      const result = retryExecutionRun(
        repository.getDatabase(),
        { taskId, worktreeVerifiedAtMs: 1 },
        300
      )

      expect(result).toEqual({ ok: false, reasonCode: 'illegal_transition' })
      expect(taskState(repository.getDatabase(), taskId)).toBe('blocked')
      expect(executionRunCount(repository.getDatabase(), taskId)).toBe(1)
    }
  )

  it.each([
    'exit_nonzero',
    'timeout',
    'interrupted',
    'spawn_failed',
    'claude_not_found',
    'empty_output'
  ] as const)('admits %s', (reason) => {
    const taskId = makeTask()
    blockWithReason(taskId, 'direct', reason)
    expect(
      retryExecutionRun(repository.getDatabase(), { taskId, worktreeVerifiedAtMs: 1 }, 300).ok
    ).toBe(true)
  })

  it('refuses a task blocked by a non-execution phase', () => {
    const taskId = makeTask()
    repository
      .getDatabase()
      .prepare(
        `UPDATE audited_tasks SET state = 'blocked', pre_block_state = 'triaging' WHERE id = ?`
      )
      .run(taskId)

    expect(
      retryExecutionRun(repository.getDatabase(), { taskId, worktreeVerifiedAtMs: 1 }, 300)
    ).toEqual({ ok: false, reasonCode: 'illegal_transition' })
  })

  it('refuses a task that is not blocked at all', async () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    seedTriageRun(repository.getDatabase(), taskId, 'prompt')

    expect(await retryExecution(taskId)).toEqual({
      ok: false,
      kind: 'execution',
      reasonCode: 'illegal_transition'
    })
    expect(verifyWorktreeForTaskMock).not.toHaveBeenCalled()
  })
})
