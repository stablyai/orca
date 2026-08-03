// Phase 4 launch admission. Ordering is load-bearing: no model invocation can
// precede worktree verification, and no process exists that is not already
// durably recorded.
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
import { startExecution } from './audited-execution-orchestration'
import {
  executionRunCount,
  seedTriagedTask,
  seedTriageRun
} from './audited-execution-test-fixtures'

let repository: AuditedTaskRepository

function makeTask(): string {
  const id = repository.createTask({
    repoId: 'repo1',
    sourceRepoPath: '/tmp/repo',
    baseCommit: 'a'.repeat(40),
    hostId: 'local',
    title: 'Do the thing',
    spec: { title: 'Do the thing', description: '' },
    source: 'custom',
    risk: 'low'
  }).id
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks SET worktree_path = '/tmp/wt', branch_name = 'b',
              worktree_provenance = 'orca_audited_v1' WHERE id = ?`
    )
    .run(id)
  return id
}

beforeEach(() => {
  verifyWorktreeForTaskMock.mockReset()
  ensureWorktreeForTaskMock.mockReset()
  runAuditedClaudeMock.mockReset()
  verifyWorktreeForTaskMock.mockResolvedValue({ ok: true })
  ensureWorktreeForTaskMock.mockResolvedValue({ ok: true })
  runAuditedClaudeMock.mockResolvedValue({ kind: 'exit', exitCode: 0, stdout: 'plan', stderr: '' })
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
})

describe('worktree verification gates the spawn', () => {
  it('spawns nothing when the worktree cannot be verified', async () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    seedTriageRun(repository.getDatabase(), taskId, 'do it')
    ensureWorktreeForTaskMock.mockResolvedValue({
      ok: false,
      reasonCode: 'head_moved_from_base_commit'
    })

    const result = await startExecution(taskId)

    // persisted: TRUE — ensureWorktreeForTask blocked the task and wrote
    // worktree_reason_code, so this reason is a durable column, not a fresh
    // read. Only retryExecution's read-only preflight may report persisted:false.
    expect(result).toEqual({
      ok: false,
      kind: 'worktree',
      reasonCode: 'head_moved_from_base_commit',
      persisted: true
    })
    expect(runAuditedClaudeMock).not.toHaveBeenCalled()
    expect(executionRunCount(repository.getDatabase(), taskId)).toBe(0)
  })

  it('reports contention without spawning', async () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    seedTriageRun(repository.getDatabase(), taskId, 'do it')
    ensureWorktreeForTaskMock.mockResolvedValue({ ok: false, contended: true })

    expect(await startExecution(taskId)).toEqual({
      ok: false,
      kind: 'execution',
      reasonCode: 'lock_contended'
    })
    expect(runAuditedClaudeMock).not.toHaveBeenCalled()
  })

  it('uses the provisioning entry point on start, not the read-only preflight', async () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    seedTriageRun(repository.getDatabase(), taskId, 'do it')

    await startExecution(taskId)

    expect(ensureWorktreeForTaskMock).toHaveBeenCalledWith(taskId)
  })
})

describe('prompt admission', () => {
  it.each([null, '', '   '])('refuses prompt %j without spawning', async (prompt) => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    seedTriageRun(repository.getDatabase(), taskId, prompt)

    expect(await startExecution(taskId)).toEqual({
      ok: false,
      kind: 'execution',
      reasonCode: 'prompt_unavailable'
    })
    expect(runAuditedClaudeMock).not.toHaveBeenCalled()
    expect(executionRunCount(repository.getDatabase(), taskId)).toBe(0)
  })

  it('refuses when no succeeded triage run exists at all', async () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')

    expect(await startExecution(taskId)).toEqual({
      ok: false,
      kind: 'execution',
      reasonCode: 'prompt_unavailable'
    })
  })

  it('passes the durable prompt to the launcher, never a caller-supplied one', async () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    seedTriageRun(repository.getDatabase(), taskId, 'the stored prompt')

    await startExecution(taskId)

    expect(runAuditedClaudeMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'the stored prompt', mode: 'plan' })
    )
  })
})

describe('state admission', () => {
  it('refuses a task in the wrong state for its mode', async () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    seedTriageRun(repository.getDatabase(), taskId, 'do it')
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'planning' WHERE id = ?`)
      .run(taskId)

    expect(await startExecution(taskId)).toEqual({
      ok: false,
      kind: 'execution',
      reasonCode: 'illegal_transition'
    })
    expect(runAuditedClaudeMock).not.toHaveBeenCalled()
  })

  it.each(['landed', 'cancelled', 'committed', 'awaiting_code_audit'] as const)(
    'refuses a start from %s',
    async (state) => {
      const taskId = makeTask()
      seedTriagedTask(repository, taskId, 'direct')
      seedTriageRun(repository.getDatabase(), taskId, 'do it')
      repository
        .getDatabase()
        .prepare(`UPDATE audited_tasks SET state = ? WHERE id = ?`)
        .run(state, taskId)

      const result = await startExecution(taskId)
      expect(result.ok).toBe(false)
      expect(runAuditedClaudeMock).not.toHaveBeenCalled()
    }
  )

  it('refuses a task with no triage decision', async () => {
    const taskId = makeTask()
    seedTriageRun(repository.getDatabase(), taskId, 'do it')

    expect(await startExecution(taskId)).toEqual({
      ok: false,
      kind: 'execution',
      reasonCode: 'illegal_transition'
    })
  })
})

describe('the run row precedes the process', () => {
  it('has a running row committed before the launcher is invoked', async () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    seedTriageRun(repository.getDatabase(), taskId, 'do it')

    let rowsAtLaunch = -1
    runAuditedClaudeMock.mockImplementation(async () => {
      rowsAtLaunch = executionRunCount(repository.getDatabase(), taskId)
      return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' }
    })

    await startExecution(taskId)

    expect(rowsAtLaunch).toBe(1)
  })
})
