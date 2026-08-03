// Phase 4 §2. The direct regression test for the retry-preflight defect:
// ensureWorktreeForTask cannot truthfully report a worktree reason for an
// already-blocked task whose worktree_reason_code is null — it returns
// `contended`. verifyWorktreeForTask exists to return the REAL reason while
// writing nothing at all.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunnerModuleNamespace from '../git/runner'

type GitRunnerModule = typeof GitRunnerModuleNamespace

const { gitExecFileAsyncSpy } = vi.hoisted(() => ({ gitExecFileAsyncSpy: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

vi.mock('../git/runner', async () => {
  const actual = await vi.importActual<GitRunnerModule>('../git/runner')
  return {
    ...actual,
    gitExecFileAsync: (argv: string[], options: Record<string, unknown>) => {
      gitExecFileAsyncSpy(argv, options)
      return actual.gitExecFileAsync(argv, options as never)
    }
  }
})

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { findGitSubcommand, isReadOnlyAuditedArgv } from './audited-worktree-commands'
import { clearAuditedWorktreeRegistryForTests } from './audited-worktree-registry'
import {
  ensureWorktreeForTask,
  setAuditedWorktreeStore,
  verifyWorktreeForTask
} from './audited-worktree-service'
import { createTestRepo, git, type TestRepo } from './audited-worktree-test-repo'

let testRepo: TestRepo
let repository: AuditedTaskRepository

function createTask(): string {
  return repository.createTask({
    repoId: 'repo1',
    sourceRepoPath: testRepo.repoPath,
    baseCommit: testRepo.headCommit,
    hostId: 'local',
    title: 'Do the thing',
    spec: { title: 'Do the thing', description: '' },
    source: 'custom',
    risk: 'low'
  }).id
}

/** Forces the task into the exact shape a Phase 4 execution block produces. */
function blockByExecution(taskId: string, preBlockState: 'implementing' | 'planning'): void {
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks
          SET state = 'blocked', pre_block_state = ?, blocked_reason_code = 'implement_process_failed',
              blocked_phase = 'execution', worktree_reason_code = NULL
        WHERE id = ?`
    )
    .run(preBlockState, taskId)
}

function taskSnapshot(taskId: string): Record<string, unknown> {
  return repository
    .getDatabase()
    .prepare(`SELECT * FROM audited_tasks WHERE id = ?`)
    .get(taskId) as Record<string, unknown>
}

function transitionCount(taskId: string): number {
  const row = repository
    .getDatabase()
    .prepare(`SELECT COUNT(*) AS n FROM audited_transitions WHERE task_id = ?`)
    .get(taskId) as { n: number }
  return row.n
}

function indexFingerprint(worktreeGitDir: string): { hash: string; mtimeNs: bigint } {
  const indexPath = join(worktreeGitDir, 'index')
  const stat = statSync(indexPath, { bigint: true })
  return {
    hash: createHash('sha256').update(readFileSync(indexPath)).digest('hex'),
    mtimeNs: stat.mtimeNs
  }
}

function worktreeAdminDir(worktreePath: string): string {
  const worktreeName = worktreePath.split(/[\\/]/).findLast(Boolean)
  return join(testRepo.repoPath, '.git', 'worktrees', String(worktreeName))
}

beforeEach(() => {
  gitExecFileAsyncSpy.mockClear()
  testRepo = createTestRepo()
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  setAuditedWorktreeStore({
    getRepos: () => [{ id: 'repo1', path: testRepo.repoPath }],
    getSettings: () => ({ workspaceDir: testRepo.workspaceRoot, nestWorkspaces: false })
  } as never)
  clearAuditedWorktreeRegistryForTests()
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  setAuditedWorktreeStore(undefined)
  clearAuditedWorktreeRegistryForTests()
  testRepo.cleanup()
})

describe('verifyWorktreeForTask reports the real reason for an execution-blocked task', () => {
  it('returns the actual drift code where ensureWorktreeForTask can only report contention', async () => {
    const taskId = createTask()
    await ensureWorktreeForTask(taskId)
    const worktreePath = String(repository.getTask(taskId)?.worktreePath)
    blockByExecution(taskId, 'implementing')

    // Drift the worktree from outside Orca, exactly as an external commit would.
    git(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'drift'])

    const verified = await verifyWorktreeForTask(taskId)
    expect(verified).toEqual({ ok: false, reasonCode: 'head_moved_from_base_commit' })

    // The contrast that documents why the two entry points differ: on the SAME
    // fixture, the provisioning entry point reports contention — never the real
    // reason — because the blocked task has no persisted worktree reason.
    const ensured = await ensureWorktreeForTask(taskId)
    expect(ensured).toEqual({ ok: false, contended: true })
  })

  it('writes nothing: the task row and transition history are byte-identical', async () => {
    const taskId = createTask()
    await ensureWorktreeForTask(taskId)
    const worktreePath = String(repository.getTask(taskId)?.worktreePath)
    blockByExecution(taskId, 'implementing')
    git(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'drift'])

    const before = taskSnapshot(taskId)
    const transitionsBefore = transitionCount(taskId)

    const verified = await verifyWorktreeForTask(taskId)
    expect(verified.ok).toBe(false)

    expect(taskSnapshot(taskId)).toEqual(before)
    expect(transitionCount(taskId)).toBe(transitionsBefore)
    // Explicitly: the block is untouched and no worktree reason was persisted.
    expect(before.state).toBe('blocked')
    expect(before.worktree_reason_code).toBeNull()
  })

  it('issues only read-only Git argv with optional locks disabled', async () => {
    const taskId = createTask()
    await ensureWorktreeForTask(taskId)
    blockByExecution(taskId, 'implementing')

    gitExecFileAsyncSpy.mockClear()
    await verifyWorktreeForTask(taskId)

    expect(gitExecFileAsyncSpy.mock.calls.length).toBeGreaterThan(0)
    for (const [argv, options] of gitExecFileAsyncSpy.mock.calls) {
      expect(isReadOnlyAuditedArgv(argv as string[]), `mutating argv: ${argv}`).toBe(true)
      expect(findGitSubcommand(argv as string[])).not.toBe('fetch')
      expect((options as { env?: Record<string, string> }).env?.GIT_OPTIONAL_LOCKS).toBe('0')
    }
  })

  it('does not alter the worktree index bytes or mtime', async () => {
    const taskId = createTask()
    await ensureWorktreeForTask(taskId)
    const worktreePath = String(repository.getTask(taskId)?.worktreePath)
    blockByExecution(taskId, 'implementing')

    const adminDir = worktreeAdminDir(worktreePath)
    const before = indexFingerprint(adminDir)

    await verifyWorktreeForTask(taskId)

    const after = indexFingerprint(adminDir)
    expect(after.hash).toBe(before.hash)
    expect(after.mtimeNs).toBe(before.mtimeNs)
  })

  it('creates no directory when the managed root is absent (derive, not prepare)', async () => {
    const taskId = createTask()
    // No provisioning at all, so the managed root was never created.
    const managedRootParent = join(testRepo.workspaceRoot, '.orca-audited')
    expect(existsSync(managedRootParent)).toBe(false)

    const verified = await verifyWorktreeForTask(taskId)
    expect(verified).toEqual({ ok: false, reasonCode: 'worktree_never_provisioned' })
    // prepareManagedRoot would have mkdir'd this; deriveManagedRootLayout must not.
    expect(existsSync(managedRootParent)).toBe(false)
  })

  it('returns worktree_never_provisioned for an unknown task', async () => {
    expect(await verifyWorktreeForTask('audited_missing')).toEqual({
      ok: false,
      reasonCode: 'worktree_never_provisioned'
    })
  })

  it('returns ok for a clean, provisioned worktree', async () => {
    const taskId = createTask()
    await ensureWorktreeForTask(taskId)
    blockByExecution(taskId, 'planning')

    expect(await verifyWorktreeForTask(taskId)).toEqual({ ok: true })
  })
})
