// Regression: startExecution must not launch with a PRE-ENSURE snapshot of the
// task. The task is read before ensureWorktreeForTask, and that call is exactly
// what provisions the worktree and writes its identity — so the pre-read copy
// can carry a null (or stale) worktree path while the durable row carries the
// real one. Launching with the snapshot would spawn Claude in the wrong cwd, or
// in `undefined`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureWorktreeForTaskMock, verifyWorktreeForTaskMock, runAuditedClaudeMock } = vi.hoisted(
  () => ({
    ensureWorktreeForTaskMock: vi.fn(),
    verifyWorktreeForTaskMock: vi.fn(),
    runAuditedClaudeMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

vi.mock('./audited-worktree-service', () => ({
  ensureWorktreeForTask: ensureWorktreeForTaskMock,
  verifyWorktreeForTask: verifyWorktreeForTaskMock,
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

/** A task with NO worktree identity yet — the state before provisioning. */
function makeUnprovisionedTask(): string {
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

function persistWorktreeIdentity(taskId: string, worktreePath: string): void {
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks
          SET worktree_path = ?, branch_name = 'orca/audited', worktree_provenance = 'orca_audited_v1',
              worktree_reason_code = NULL, worktree_verified_at_ms = 5
        WHERE id = ?`
    )
    .run(worktreePath, taskId)
}

beforeEach(() => {
  ensureWorktreeForTaskMock.mockReset()
  verifyWorktreeForTaskMock.mockReset()
  runAuditedClaudeMock.mockReset()
  verifyWorktreeForTaskMock.mockResolvedValue({ ok: true })
  runAuditedClaudeMock.mockResolvedValue({ kind: 'exit', exitCode: 0, stdout: 'plan', stderr: '' })
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
})

describe('the launcher cwd comes from durable storage, not the pre-ensure read', () => {
  it('uses the path ensureWorktreeForTask persisted, which was absent when the task was first read', async () => {
    const taskId = makeUnprovisionedTask()
    seedTriagedTask(repository, taskId, 'plan')
    seedTriageRun(repository.getDatabase(), taskId, 'write a plan')

    // Precondition that makes this test meaningful: at the moment startExecution
    // takes its first read, there is no worktree path at all.
    expect(repository.getTask(taskId)?.worktreePath).toBeNull()

    // Provisioning writes the identity, exactly as the real implementation does.
    ensureWorktreeForTaskMock.mockImplementation(async () => {
      persistWorktreeIdentity(taskId, '/managed/root/audited_task_worktree')
      return { ok: true }
    })

    const result = await startExecution(taskId)

    expect(result).toEqual({ ok: true })
    expect(runAuditedClaudeMock).toHaveBeenCalledTimes(1)
    expect(runAuditedClaudeMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/managed/root/audited_task_worktree' })
    )
    // The pre-ensure snapshot value must never reach the launcher.
    const [context] = runAuditedClaudeMock.mock.calls[0] as [{ worktreePath: unknown }]
    expect(context.worktreePath).not.toBeUndefined()
    expect(context.worktreePath).not.toBeNull()
  })

  it('uses a path ensureWorktreeForTask REPLACED, not the one read beforehand', async () => {
    const taskId = makeUnprovisionedTask()
    seedTriagedTask(repository, taskId, 'direct')
    seedTriageRun(repository.getDatabase(), taskId, 'do it')
    persistWorktreeIdentity(taskId, '/stale/previous/path')

    ensureWorktreeForTaskMock.mockImplementation(async () => {
      persistWorktreeIdentity(taskId, '/fresh/reprovisioned/path')
      return { ok: true }
    })

    await startExecution(taskId)

    expect(runAuditedClaudeMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/fresh/reprovisioned/path' })
    )
  })
})

describe('the refreshed row must still be launchable', () => {
  it('refuses when ensure reports ok but persisted identity is incomplete', async () => {
    const taskId = makeUnprovisionedTask()
    seedTriagedTask(repository, taskId, 'plan')
    seedTriageRun(repository.getDatabase(), taskId, 'write a plan')
    // ensure claims success but writes nothing — the row stays unprovisioned.
    ensureWorktreeForTaskMock.mockResolvedValue({ ok: true })

    const result = await startExecution(taskId)

    expect(result).toEqual({
      ok: false,
      kind: 'execution',
      reasonCode: 'worktree_not_verified'
    })
    expect(runAuditedClaudeMock).not.toHaveBeenCalled()
    expect(executionRunCount(repository.getDatabase(), taskId)).toBe(0)
  })

  it('refuses when the persisted row carries a worktree failure reason', async () => {
    const taskId = makeUnprovisionedTask()
    seedTriagedTask(repository, taskId, 'plan')
    seedTriageRun(repository.getDatabase(), taskId, 'write a plan')
    ensureWorktreeForTaskMock.mockImplementation(async () => {
      persistWorktreeIdentity(taskId, '/managed/wt')
      repository
        .getDatabase()
        .prepare(`UPDATE audited_tasks SET worktree_reason_code = 'worktree_missing' WHERE id = ?`)
        .run(taskId)
      return { ok: true }
    })

    expect(await startExecution(taskId)).toEqual({
      ok: false,
      kind: 'execution',
      reasonCode: 'worktree_not_verified'
    })
    expect(runAuditedClaudeMock).not.toHaveBeenCalled()
  })

  it('refuses when a concurrent writer moved the task during provisioning', async () => {
    const taskId = makeUnprovisionedTask()
    seedTriagedTask(repository, taskId, 'direct')
    seedTriageRun(repository.getDatabase(), taskId, 'do it')

    ensureWorktreeForTaskMock.mockImplementation(async () => {
      persistWorktreeIdentity(taskId, '/managed/wt')
      // A concurrent block lands while provisioning was running.
      repository
        .getDatabase()
        .prepare(`UPDATE audited_tasks SET state = 'blocked' WHERE id = ?`)
        .run(taskId)
      return { ok: true }
    })

    expect(await startExecution(taskId)).toEqual({
      ok: false,
      kind: 'execution',
      reasonCode: 'illegal_transition'
    })
    expect(runAuditedClaudeMock).not.toHaveBeenCalled()
    expect(executionRunCount(repository.getDatabase(), taskId)).toBe(0)
  })
})
