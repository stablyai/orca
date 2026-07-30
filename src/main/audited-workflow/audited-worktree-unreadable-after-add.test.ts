// Regression: `worktree_unreadable` raised by post-add drift verification.
//
// `git worktree add` has already SUCCEEDED, so the attempt is failed_ambiguous
// and its path stays guarded. Retrying would claim a fresh attempt against real,
// unexplained Git state — so recovery must refuse, the UI must offer no retry,
// and a restart must preserve the refusal.
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import type { AuditedTaskRow } from './audited-task-row-mapping'
import { rebuildRegistryFromDatabase } from './audited-worktree-attempt-repository'
import { isAuditedWorktreePath } from './audited-worktree-registry'
import {
  clearAuditedWorktreeRegistryForTests,
  resetAuditedWorktreeRegistryStateForTests
} from './audited-worktree-registry'
import { resolveRecoveryAdmission } from './audited-worktree-recovery'
import {
  ensureWorktreeForTask,
  recoverWorktreeForTask,
  setAuditedWorktreeStore
} from './audited-worktree-service'
import { createTestRepo, git, listRefs, type TestRepo } from './audited-worktree-test-repo'
import { isRetryableProvisioningReasonCode } from '../../shared/audited-worktree-types'
import * as driftVerifier from './audited-worktree-drift-verifier'

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

function attemptsFor(taskId: string): { id: string; status: string; intended_path: string }[] {
  return repository
    .getDatabase()
    .prepare(`SELECT id, status, intended_path FROM audited_worktree_attempts WHERE task_id = ?`)
    .all(taskId) as { id: string; status: string; intended_path: string }[]
}

beforeEach(() => {
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
  resetAuditedWorktreeRegistryStateForTests()
  vi.restoreAllMocks()
  testRepo.cleanup()
})

describe('worktree_unreadable after a successful worktree-add', () => {
  it('blocks, keeps the path guarded, refuses retry, and survives restart', async () => {
    const task = makeTask()
    // The add succeeds; verification then reports the tree unreadable.
    vi.spyOn(driftVerifier, 'verifyAuditedWorktree').mockResolvedValue({
      ok: false,
      reasonCode: 'worktree_unreadable'
    })

    const outcome = await ensureWorktreeForTask(task.id)

    expect(outcome).toEqual({ ok: false, reasonCode: 'worktree_unreadable' })

    // The worktree really was created — this is exactly why retry is unsafe.
    const attempts = attemptsFor(task.id)
    expect(attempts).toHaveLength(1)
    expect(attempts[0].status).toBe('failed_ambiguous')
    expect(existsSync(attempts[0].intended_path)).toBe(true)
    expect(isAuditedWorktreePath(attempts[0].intended_path)).toBe(true)

    const blocked = repository.getTask(task.id) as AuditedTaskRow
    expect(blocked.state).toBe('blocked')
    expect(blocked.preBlockState).toBe('selected')
    expect(blocked.worktreeReasonCode).toBe('worktree_unreadable')
    // worktreeReady must be false: no verification succeeded.
    expect(blocked.worktreeVerifiedAt).toBeNull()

    // The main process refuses recovery on durable attempt state...
    expect(resolveRecoveryAdmission(repository.getDatabase(), blocked)).toEqual({
      admissible: false
    })
    const recovered = await recoverWorktreeForTask(task.id)
    expect(recovered).toEqual({ ok: false, notAdmissible: true })

    // ...and no second attempt was inserted.
    expect(attemptsFor(task.id)).toHaveLength(1)

    // The UI offers no Retry for this code at all.
    expect(isRetryableProvisioningReasonCode('worktree_unreadable')).toBe(false)

    // Restart: evidence is untouched and the path is guarded again.
    const refsBefore = listRefs(testRepo.repoPath)
    resetAuditedWorktreeRegistryStateForTests()
    rebuildRegistryFromDatabase(repository.getDatabase())

    expect(isAuditedWorktreePath(attempts[0].intended_path)).toBe(true)
    expect(listRefs(testRepo.repoPath)).toEqual(refsBefore)
    expect(existsSync(attempts[0].intended_path)).toBe(true)

    // A post-restart recovery attempt is still refused.
    expect(await recoverWorktreeForTask(task.id)).toEqual({ ok: false, notAdmissible: true })
    expect(attemptsFor(task.id)).toHaveLength(1)
  })

  it('refuses a fresh claim in the provisioning layer itself, not only via recovery', async () => {
    const task = makeTask()
    vi.spyOn(driftVerifier, 'verifyAuditedWorktree').mockResolvedValue({
      ok: false,
      reasonCode: 'worktree_unreadable'
    })
    await ensureWorktreeForTask(task.id)
    vi.restoreAllMocks()

    // Even calling ensure directly (bypassing recovery admission) is refused.
    const second = await ensureWorktreeForTask(task.id)

    // The task is already blocked, so the caller is told what the row actually
    // holds — the original worktree_unreadable — rather than this call's own
    // internal provision_evidence_ambiguous, which was never persisted.
    expect(second).toEqual({ ok: false, reasonCode: 'worktree_unreadable' })
    expect(repository.getTask(task.id)?.worktreeReasonCode).toBe('worktree_unreadable')
    // The refusal is what matters: no second attempt was ever claimed.
    expect(attemptsFor(task.id)).toHaveLength(1)
    expect(attemptsFor(task.id)[0].status).toBe('failed_ambiguous')
  })

  it('leaves the source working tree and refs untouched', async () => {
    const task = makeTask()
    const refsBefore = listRefs(testRepo.repoPath)
    const headBefore = git(testRepo.repoPath, ['rev-parse', 'HEAD'])
    vi.spyOn(driftVerifier, 'verifyAuditedWorktree').mockResolvedValue({
      ok: false,
      reasonCode: 'worktree_unreadable'
    })

    await ensureWorktreeForTask(task.id)

    // The audited branch ref is expected; HEAD and the working tree are not touched.
    expect(git(testRepo.repoPath, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(git(testRepo.repoPath, ['status', '--porcelain'])).toBe('')
    expect(listRefs(testRepo.repoPath).length).toBe(refsBefore.length + 1)
  })
})
