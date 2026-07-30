// Audit findings 1 and 2:
//  1. An unresolvable workspace root must CAS-block the task, not silently
//     leave it `selected`.
//  2. Finalization must never overwrite a concurrent reconciliation that
//     already classified the attempt as failed_ambiguous and blocked the task.
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
  markAttemptFailedAmbiguous
} from './audited-worktree-attempt-repository'
import {
  setAfterWorktreeAddHookForTests
} from './audited-worktree-provisioning'
import { clearAuditedWorktreeRegistryForTests } from './audited-worktree-registry'
import { resolveRecoveryAdmission } from './audited-worktree-recovery'
import {
  ensureWorktreeForTask,
  recoverWorktreeForTask,
  setAuditedWorktreeStore
} from './audited-worktree-service'
import { blockTaskForWorktreeFailure } from './audited-worktree-task-writes'
import { createTestRepo, type TestRepo } from './audited-worktree-test-repo'

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

function reload(taskId: string): AuditedTaskRow {
  const row = repository.getTask(taskId)
  if (!row) {
    throw new Error('task vanished')
  }
  return row
}

/** Points the service at a real repo and workspace root. */
function useResolvableStore(): void {
  setAuditedWorktreeStore({
    getRepos: () => [{ id: 'repo1', path: testRepo.repoPath }],
    getSettings: () => ({ workspaceDir: testRepo.workspaceRoot, nestWorkspaces: false })
  } as never)
}

beforeEach(() => {
  testRepo = createTestRepo()
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  useResolvableStore()
  clearAuditedWorktreeRegistryForTests()
})

afterEach(() => {
  setAfterWorktreeAddHookForTests(undefined)
  setAuditedTaskRepositoryForTests(undefined)
  setAuditedWorktreeStore(undefined)
  clearAuditedWorktreeRegistryForTests()
  testRepo.cleanup()
})

describe('unresolvable workspace root blocks the task', () => {
  it('moves selected -> blocked with managed_root_unavailable', async () => {
    const task = makeTask()
    // The repo is no longer registered, so no workspace root can be derived.
    setAuditedWorktreeStore({
      getRepos: () => [],
      getSettings: () => ({ workspaceDir: '', nestWorkspaces: false })
    } as never)

    const outcome = await ensureWorktreeForTask(task.id)

    expect(outcome).toEqual({ ok: false, reasonCode: 'managed_root_unavailable' })
    const blocked = reload(task.id)
    expect(blocked.state).toBe('blocked')
    expect(blocked.preBlockState).toBe('selected')
    expect(blocked.blockedReasonCode).toBe('worktree_provision_failed')
    expect(blocked.worktreeReasonCode).toBe('managed_root_unavailable')
    expect(blocked.worktreeVerifiedAt).toBeNull()
    // No attempt was claimed, so nothing is guarded and nothing to clean.
    expect(getLiveAttempt(repository.getDatabase(), task.id)).toBeNull()
  })

  it('leaves the task recoverable, and recovery succeeds once the root resolves', async () => {
    const task = makeTask()
    setAuditedWorktreeStore({
      getRepos: () => [],
      getSettings: () => ({ workspaceDir: '', nestWorkspaces: false })
    } as never)
    await ensureWorktreeForTask(task.id)

    // Admissible: no attempt was ever claimed, so a fresh claim is safe.
    expect(resolveRecoveryAdmission(repository.getDatabase(), reload(task.id))).toEqual({
      admissible: true,
      restoreTo: 'selected'
    })

    useResolvableStore()
    const recovered = await recoverWorktreeForTask(task.id)

    expect(recovered).toEqual({ ok: true, restoredState: 'selected' })
    const restored = reload(task.id)
    expect(restored.state).toBe('selected')
    expect(restored.worktreeReasonCode).toBeNull()
    expect(restored.worktreeProvenance).toBe('orca_audited_v1')
  })

  it('never overwrites an earlier block recorded by a concurrent writer', async () => {
    const task = makeTask()
    setAuditedWorktreeStore({
      getRepos: () => [],
      getSettings: () => ({ workspaceDir: '', nestWorkspaces: false })
    } as never)
    // Something else blocks the task first with a DIFFERENT reason.
    blockTaskForWorktreeFailure(
      repository.getDatabase(),
      task.id,
      'selected',
      'worktree_unreadable',
      1
    )

    const outcome = await ensureWorktreeForTask(task.id)

    // The caller is told what the task row ACTUALLY says — the first writer's
    // reason — not this call's own managed_root_unavailable, which was never
    // persisted. The renderer gates recovery affordances on this value.
    expect(outcome).toEqual({ ok: false, reasonCode: 'worktree_unreadable' })
    // The FIRST writer's terminal classification survives untouched, and
    // pre_block_state still points at the state recovery must restore to.
    const blocked = reload(task.id)
    expect(blocked.worktreeReasonCode).toBe('worktree_unreadable')
    expect(blocked.preBlockState).toBe('selected')
  })

  it('reports contention when the task is blocked with no worktree reason', async () => {
    const task = makeTask()
    setAuditedWorktreeStore({
      getRepos: () => [],
      getSettings: () => ({ workspaceDir: '', nestWorkspaces: false })
    } as never)
    // Blocked by a NON-worktree phase: worktree_reason_code stays null, so there
    // is no truthful worktree reason to report.
    repository
      .getDatabase()
      .prepare(
        `UPDATE audited_tasks
            SET state = 'blocked', pre_block_state = 'triaging',
                blocked_reason_code = 'triage_process_failed', worktree_reason_code = NULL
          WHERE id = ?`
      )
      .run(task.id)

    const outcome = await ensureWorktreeForTask(task.id)

    expect(outcome).toEqual({ ok: false, contended: true })
    // No reason was invented, and the unrelated block is left intact.
    const blocked = reload(task.id)
    expect(blocked.worktreeReasonCode).toBeNull()
    expect(blocked.blockedReasonCode).toBe('triage_process_failed')
    expect(blocked.preBlockState).toBe('triaging')
  })
})

describe('finalization never overwrites a concurrent terminal outcome', () => {
  it('refuses to finalize after a reconciliation marked the attempt failed_ambiguous', async () => {
    const task = makeTask()

    // Deterministic race: the worktree-add has succeeded and the hook runs in
    // exactly the window before verification/finalization. A concurrent
    // reconciliation classifies the attempt as ambiguous and blocks the task.
    setAfterWorktreeAddHookForTests(async () => {
      const live = getLiveAttempt(repository.getDatabase(), task.id)
      if (!live) {
        throw new Error('expected a live attempt')
      }
      markAttemptFailedAmbiguous(
        repository.getDatabase(),
        live.id,
        'provision_evidence_ambiguous',
        2
      )
      blockTaskForWorktreeFailure(
        repository.getDatabase(),
        task.id,
        'selected',
        'provision_evidence_ambiguous',
        2
      )
    })

    const outcome = await ensureWorktreeForTask(task.id)

    // The original provisioning call must yield, not clobber.
    expect(outcome).toEqual({ ok: false, contended: true })

    const after = reload(task.id)
    expect(after.state).toBe('blocked')
    expect(after.worktreeReasonCode).toBe('provision_evidence_ambiguous')
    // Crucially: NO worktree identity was written over the block.
    expect(after.worktreeProvenance).toBeNull()
    expect(after.worktreePath).toBeNull()
    expect(after.branchName).toBeNull()
    expect(after.worktreeVerifiedAt).toBeNull()

    // The attempt keeps the reconciliation's terminal status.
    const attempts = repository
      .getDatabase()
      .prepare(`SELECT status, reason_code FROM audited_worktree_attempts WHERE task_id = ?`)
      .all(task.id) as { status: string; reason_code: string }[]
    expect(attempts).toHaveLength(1)
    expect(attempts[0].status).toBe('failed_ambiguous')
    expect(attempts[0].reason_code).toBe('provision_evidence_ambiguous')
  })

  it('still finalizes normally when no concurrent writer intervenes', async () => {
    const task = makeTask()

    const outcome = await ensureWorktreeForTask(task.id)

    expect(outcome).toEqual({ ok: true })
    const finalized = reload(task.id)
    expect(finalized.worktreeProvenance).toBe('orca_audited_v1')
    expect(finalized.worktreeVerifiedAt).not.toBeNull()
    const attempts = repository
      .getDatabase()
      .prepare(`SELECT status FROM audited_worktree_attempts WHERE task_id = ?`)
      .all(task.id) as { status: string }[]
    expect(attempts.map((a) => a.status)).toEqual(['finalized'])
  })
})
