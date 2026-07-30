import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import type { AuditedTaskRow } from './audited-task-row-mapping'
import {
  getLiveAttempt,
  listGuardedAttempts
} from './audited-worktree-attempt-repository'
import {
  ensureAuditedWorktree,
  setAfterWorktreeAddHookForTests
} from './audited-worktree-provisioning'
import {
  clearAuditedWorktreeRegistryForTests,
  isAuditedWorktreePath,
  rebuildAuditedWorktreeRegistry
} from './audited-worktree-registry'
import { rebuildRegistryFromDatabase } from './audited-worktree-attempt-repository'
import { deriveAuditedBranchName } from './audited-worktree-identity'
import { createTestRepo, git, listRefs, statusPorcelain, trackedFileHashes } from './audited-worktree-test-repo'
import type { TestRepo } from './audited-worktree-test-repo'

let testRepo: TestRepo
let repository: AuditedTaskRepository

function makeTask(): AuditedTaskRow {
  return repository.createTask({
    repoId: 'repo1',
    sourceRepoPath: testRepo.repoPath,
    baseCommit: testRepo.headCommit,
    hostId: 'local',
    title: 'Do the thing',
    spec: { title: 'Do the thing', description: '' },
    source: 'custom',
    risk: 'low'
  })
}

function provision(task: AuditedTaskRow) {
  return ensureAuditedWorktree({
    db: repository.getDatabase(),
    task,
    workspaceRoot: testRepo.workspaceRoot,
    nowMs: () => 1_000
  })
}

beforeEach(() => {
  testRepo = createTestRepo()
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  clearAuditedWorktreeRegistryForTests()
})

afterEach(() => {
  setAfterWorktreeAddHookForTests(undefined)
  setAuditedTaskRepositoryForTests(undefined)
  clearAuditedWorktreeRegistryForTests()
  testRepo.cleanup()
})

describe('provisioning a real worktree', () => {
  it('creates the worktree at exactly the persisted base commit', async () => {
    const task = makeTask()

    const result = await provision(task)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected ok')
    }
    expect(existsSync(result.worktreePath)).toBe(true)
    expect(git(result.worktreePath, ['rev-parse', 'HEAD'])).toBe(testRepo.headCommit)
    expect(git(result.worktreePath, ['symbolic-ref', '--quiet', 'HEAD'])).toBe(
      `refs/heads/${deriveAuditedBranchName(task.id)}`
    )
    const reloaded = repository.getTask(task.id)
    expect(reloaded?.worktreeProvenance).toBe('orca_audited_v1')
    expect(reloaded?.branchName).toBe(deriveAuditedBranchName(task.id))
  })

  it('succeeds when origin is unreachable (no network access at all)', async () => {
    testRepo.cleanup()
    testRepo = createTestRepo({ origin: 'file:///definitely/not/here' })
    repository = new AuditedTaskRepository(':memory:')
    setAuditedTaskRepositoryForTests(repository)

    const result = await provision(makeTask())

    expect(result.ok).toBe(true)
  })

  it('leaves the source WORKING TREE untouched while allowing expected metadata changes', async () => {
    const task = makeTask()
    const statusBefore = statusPorcelain(testRepo.repoPath)
    const trackedBefore = trackedFileHashes(testRepo.repoPath)
    const headBefore = git(testRepo.repoPath, ['rev-parse', 'HEAD'])
    const branchBefore = git(testRepo.repoPath, ['symbolic-ref', 'HEAD'])
    const refsBefore = listRefs(testRepo.repoPath)

    await provision(task)

    expect(statusPorcelain(testRepo.repoPath)).toBe(statusBefore)
    expect(trackedFileHashes(testRepo.repoPath)).toBe(trackedBefore)
    expect(git(testRepo.repoPath, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(git(testRepo.repoPath, ['symbolic-ref', 'HEAD'])).toBe(branchBefore)
    // Expected and permitted: the new branch ref plus the admin record.
    const refsAfter = listRefs(testRepo.repoPath)
    const added = refsAfter.filter((ref) => !refsBefore.includes(ref))
    expect(added).toHaveLength(1)
    expect(added[0]).toContain(`refs/heads/${deriveAuditedBranchName(task.id)}`)
    expect(existsSync(join(testRepo.repoPath, '.git', 'worktrees'))).toBe(true)
  })

  it('is idempotent: a second ensure verifies rather than creating a second worktree', async () => {
    const task = makeTask()
    const first = await provision(task)
    expect(first.ok).toBe(true)

    const reloaded = repository.getTask(task.id) as AuditedTaskRow
    const second = await provision(reloaded)

    expect(second.ok).toBe(true)
    expect(listGuardedAttempts(repository.getDatabase())).toHaveLength(1)
  })

  it('creates at most one worktree and one attempt under concurrent ensure calls', async () => {
    const task = makeTask()

    const [a, b] = await Promise.all([provision(task), provision(task)])

    const succeeded = [a, b].filter((r) => r.ok)
    expect(succeeded).toHaveLength(1)
    expect(listGuardedAttempts(repository.getDatabase())).toHaveLength(1)
  })
})

describe('guard registry coverage during provisioning', () => {
  it('guards the intended path from claim time, before git worktree add runs', async () => {
    const task = makeTask()
    let guardedDuringAdd = false

    // Parks provisioning in the exact window between a successful worktree-add
    // and verification/finalization — the window a finalize-only registry missed.
    setAfterWorktreeAddHookForTests(async () => {
      const attempt = getLiveAttempt(repository.getDatabase(), task.id)
      guardedDuringAdd = isAuditedWorktreePath(attempt?.intendedPath ?? '')
    })

    const result = await provision(task)

    expect(guardedDuringAdd).toBe(true)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected ok')
    }
    expect(isAuditedWorktreePath(result.worktreePath)).toBe(true)
  })

  it('keeps the path guarded across every non-released attempt status', async () => {
    const task = makeTask()
    const result = await provision(task)
    if (!result.ok) {
      throw new Error('expected ok')
    }

    // finalized
    expect(isAuditedWorktreePath(result.worktreePath)).toBe(true)
    // and again after a restart-equivalent rebuild
    clearAuditedWorktreeRegistryForTests()
    rebuildRegistryFromDatabase(repository.getDatabase())
    expect(isAuditedWorktreePath(result.worktreePath)).toBe(true)
  })

  it('does not guard ordinary worktree paths', async () => {
    await provision(makeTask())
    expect(isAuditedWorktreePath(join(testRepo.workspaceRoot, 'ordinary-feature'))).toBe(false)
    expect(isAuditedWorktreePath(testRepo.repoPath)).toBe(false)
  })

  it('rebuildAuditedWorktreeRegistry replaces rather than accumulating', () => {
    rebuildAuditedWorktreeRegistry(['/a/one'])
    expect(isAuditedWorktreePath('/a/one')).toBe(true)
    rebuildAuditedWorktreeRegistry(['/a/two'])
    expect(isAuditedWorktreePath('/a/one')).toBe(false)
    expect(isAuditedWorktreePath('/a/two')).toBe(true)
  })
})

describe('failed git worktree add', () => {
  it('releases the path and allows an explicit retry when no side effects remain', async () => {
    const task = makeTask()
    // A base commit that does not exist: git fails and creates nothing.
    const broken = { ...task, baseCommit: 'f'.repeat(40) }

    const result = await ensureAuditedWorktree({
      db: repository.getDatabase(),
      task: broken,
      workspaceRoot: testRepo.workspaceRoot,
      nowMs: () => 1_000
    })

    expect(result).toEqual({ ok: false, reasonCode: 'git_worktree_add_failed' })
    const attempts = repository
      .getDatabase()
      .prepare(`SELECT status FROM audited_worktree_attempts WHERE task_id = ?`)
      .all(task.id) as { status: string }[]
    expect(attempts.map((a) => a.status)).toEqual(['failed_no_effect'])
    expect(listGuardedAttempts(repository.getDatabase())).toHaveLength(0)

    // A fresh attempt may claim the same path and succeed.
    const retry = await provision(repository.getTask(task.id) as AuditedTaskRow)
    expect(retry.ok).toBe(true)
  })

  it('a released path is NOT re-added by a restart rebuild', async () => {
    const task = makeTask()
    await ensureAuditedWorktree({
      db: repository.getDatabase(),
      task: { ...task, baseCommit: 'f'.repeat(40) },
      workspaceRoot: testRepo.workspaceRoot,
      nowMs: () => 1_000
    })

    clearAuditedWorktreeRegistryForTests()
    const rebuilt = rebuildRegistryFromDatabase(repository.getDatabase())

    expect(rebuilt).toHaveLength(0)
  })

  it('blocks as ambiguous and KEEPS the path guarded when partial evidence remains', async () => {
    const task = makeTask()
    const branch = deriveAuditedBranchName(task.id)
    // Branch-only remnant: git worktree add then fails because it already exists.
    git(testRepo.repoPath, ['branch', branch, testRepo.headCommit])
    const refsBefore = listRefs(testRepo.repoPath)

    const result = await provision(task)

    expect(result).toEqual({ ok: false, reasonCode: 'provision_evidence_ambiguous' })
    // Evidence preserved exactly — nothing deleted, pruned, or reset.
    expect(listRefs(testRepo.repoPath)).toEqual(refsBefore)
    const attempt = repository
      .getDatabase()
      .prepare(`SELECT status, intended_path FROM audited_worktree_attempts WHERE task_id = ?`)
      .get(task.id) as { status: string; intended_path: string }
    expect(attempt.status).toBe('failed_ambiguous')
    expect(isAuditedWorktreePath(attempt.intended_path)).toBe(true)
  })

  it('reports an occupied path when the target is a non-worktree directory', async () => {
    const task = makeTask()
    const occupied = join(testRepo.workspaceRoot, '.orca-audited', 'repo1', task.id)
    mkdirSync(occupied, { recursive: true })
    writeFileSync(join(occupied, 'stray.txt'), 'not a worktree')

    const result = await provision(task)

    expect(result).toEqual({ ok: false, reasonCode: 'worktree_path_occupied' })
    expect(existsSync(join(occupied, 'stray.txt'))).toBe(true)
  })
})

describe('crash recovery evidence', () => {
  it('adopts an exactly-matching worktree left by a crash before finalization', async () => {
    const task = makeTask()
    // Simulate the crash: park after worktree-add, then abort the flow.
    let intendedPath = ''
    setAfterWorktreeAddHookForTests(async () => {
      const attempt = getLiveAttempt(repository.getDatabase(), task.id)
      intendedPath = attempt?.intendedPath ?? ''
      throw new Error('simulated crash before finalization')
    })
    await expect(provision(task)).rejects.toThrow(/simulated crash/)
    setAfterWorktreeAddHookForTests(undefined)

    // The worktree exists on disk and the attempt is still live.
    expect(existsSync(intendedPath)).toBe(true)
    expect(getLiveAttempt(repository.getDatabase(), task.id)?.status).toBe('claimed')

    // Re-running ensure adopts it rather than creating a second worktree.
    const result = await provision(repository.getTask(task.id) as AuditedTaskRow)

    expect(result.ok).toBe(true)
    expect(repository.getTask(task.id)?.worktreeProvenance).toBe('orca_audited_v1')
  })

  it('refuses to adopt when the branch tip moved away from the base commit', async () => {
    const task = makeTask()
    const result = await provision(task)
    if (!result.ok) {
      throw new Error('expected ok')
    }
    // A commit made outside Orca — the guard cannot prevent this, only detect it.
    writeFileSync(join(result.worktreePath, 'rogue.txt'), 'x')
    git(result.worktreePath, ['add', 'rogue.txt'])
    git(result.worktreePath, ['commit', '-m', 'rogue'])

    const reverify = await provision(repository.getTask(task.id) as AuditedTaskRow)

    expect(reverify).toEqual({ ok: false, reasonCode: 'head_moved_from_base_commit' })
    // The rogue commit is preserved for the user to inspect.
    expect(existsSync(join(result.worktreePath, 'rogue.txt'))).toBe(true)
  })

  it('detects a detached HEAD as drift', async () => {
    const task = makeTask()
    const result = await provision(task)
    if (!result.ok) {
      throw new Error('expected ok')
    }
    git(result.worktreePath, ['checkout', '--detach', testRepo.headCommit])

    const reverify = await provision(repository.getTask(task.id) as AuditedTaskRow)

    expect(reverify).toEqual({ ok: false, reasonCode: 'head_not_symbolic' })
  })

  it('detects a missing worktree directory as drift', async () => {
    const task = makeTask()
    const result = await provision(task)
    if (!result.ok) {
      throw new Error('expected ok')
    }
    rmSync(result.worktreePath, { recursive: true, force: true })

    const reverify = await provision(repository.getTask(task.id) as AuditedTaskRow)

    expect(reverify).toEqual({ ok: false, reasonCode: 'worktree_missing' })
  })
})
