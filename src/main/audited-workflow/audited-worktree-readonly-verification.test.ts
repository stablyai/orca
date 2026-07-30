// Proves verification and reconciliation are genuinely read-only: they must not
// rewrite .git/index. This is why every audited read command sets
// GIT_OPTIONAL_LOCKS=0 and uses rev-parse/symbolic-ref rather than `git status`.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunnerModuleNamespace from '../git/runner'

type GitRunnerModule = typeof GitRunnerModuleNamespace

const { gitExecFileAsyncSpy } = vi.hoisted(() => ({ gitExecFileAsyncSpy: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

// Records every argv/options pair while still running the real Git command.
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
  reconcileAuditedWorktreesOnStartup,
  setAuditedWorktreeStore
} from './audited-worktree-service'
import { createTestRepo, type TestRepo } from './audited-worktree-test-repo'

let testRepo: TestRepo
let repository: AuditedTaskRepository

function indexFingerprint(worktreeGitDir: string): { hash: string; mtimeNs: bigint } {
  const indexPath = join(worktreeGitDir, 'index')
  const stat = statSync(indexPath, { bigint: true })
  return {
    hash: createHash('sha256').update(readFileSync(indexPath)).digest('hex'),
    mtimeNs: stat.mtimeNs
  }
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

describe('reconciliation is read-only', () => {
  it('does not alter the worktree index bytes or mtime', async () => {
    const task = repository.createTask({
      repoId: 'repo1',
      sourceRepoPath: testRepo.repoPath,
      baseCommit: testRepo.headCommit,
      hostId: 'local',
      title: 'Do the thing',
      spec: { title: 'Do the thing', description: '' },
      source: 'custom',
      risk: 'low'
    })
    await ensureWorktreeForTask(task.id)
    const provisioned = repository.getTask(task.id)
    // A linked worktree's index lives under .git/worktrees/<name>/index.
    const worktreeName = String(provisioned?.worktreePath).split(/[\\/]/).findLast(Boolean)
    const adminDir = join(testRepo.repoPath, '.git', 'worktrees', String(worktreeName))
    const before = indexFingerprint(adminDir)

    gitExecFileAsyncSpy.mockClear()
    await reconcileAuditedWorktreesOnStartup()

    const after = indexFingerprint(adminDir)
    expect(after.hash).toBe(before.hash)
    expect(after.mtimeNs).toBe(before.mtimeNs)
  })

  it('issues only read-only Git commands, each with optional locks disabled', async () => {
    const task = repository.createTask({
      repoId: 'repo1',
      sourceRepoPath: testRepo.repoPath,
      baseCommit: testRepo.headCommit,
      hostId: 'local',
      title: 'Do the thing',
      spec: { title: 'Do the thing', description: '' },
      source: 'custom',
      risk: 'low'
    })
    await ensureWorktreeForTask(task.id)

    gitExecFileAsyncSpy.mockClear()
    await reconcileAuditedWorktreesOnStartup()

    expect(gitExecFileAsyncSpy.mock.calls.length).toBeGreaterThan(0)
    for (const [argv, options] of gitExecFileAsyncSpy.mock.calls) {
      expect(isReadOnlyAuditedArgv(argv as string[]), `mutating argv: ${argv}`).toBe(true)
      expect(findGitSubcommand(argv as string[])).not.toBe('fetch')
      expect((options as { env?: Record<string, string> }).env?.GIT_OPTIONAL_LOCKS).toBe('0')
    }
  })
})
