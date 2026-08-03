import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { setTriageProviderForTests, startTriage, retryTriage } from './audited-triage-orchestration'
import type { AuditedTaskRow } from './audited-task-row-mapping'
import { clearAuditedWorktreeRegistryForTests } from './audited-worktree-registry'
import { resolveRecoveryAdmission } from './audited-worktree-recovery'
import {
  ensureWorktreeForTask,
  recoverWorktreeForTask,
  reconcileAuditedWorktreesOnStartup,
  setAuditedWorktreeStore
} from './audited-worktree-service'
import { createTestRepo, type TestRepo } from './audited-worktree-test-repo'

let testRepo: TestRepo
let repository: AuditedTaskRepository

function makeTask(overrides: Partial<{ baseCommit: string }> = {}): AuditedTaskRow {
  return repository.createTask({
    repoId: 'repo1',
    sourceRepoPath: testRepo.repoPath,
    baseCommit: overrides.baseCommit ?? testRepo.headCommit,
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
  setTriageProviderForTests(undefined)
  clearAuditedWorktreeRegistryForTests()
  testRepo.cleanup()
})

describe('resolveRecoveryAdmission', () => {
  function blockedTask(
    preBlockState: AuditedTaskRow['preBlockState'],
    worktreeReasonCode: AuditedTaskRow['worktreeReasonCode']
  ): AuditedTaskRow {
    return { ...makeTask(), state: 'blocked', preBlockState, worktreeReasonCode }
  }

  function db(): ReturnType<AuditedTaskRepository['getDatabase']> {
    return repository.getDatabase()
  }

  /** Inserts an attempt row in a given terminal/live status for a task. */
  function seedAttempt(taskId: string, status: string): void {
    db()
      .prepare(
        `INSERT INTO audited_worktree_attempts (id, task_id, status, intended_branch,
           intended_path, intended_base_commit, intended_common_dir, provenance_id, claimed_at_ms)
         VALUES (?, ?, ?, 'b', '/p', 'aaa', '/c', 'prov', 1)`
      )
      .run(`attempt_${taskId}_${status}`, taskId, status)
  }

  it('admits git_worktree_add_failed ONLY when the attempt proved no side effects', () => {
    const task = blockedTask('selected', 'git_worktree_add_failed')
    seedAttempt(task.id, 'failed_no_effect')

    expect(resolveRecoveryAdmission(db(), task)).toEqual({
      admissible: true,
      restoreTo: 'selected'
    })
  })

  it('refuses git_worktree_add_failed when no attempt proves absence of side effects', () => {
    const task = blockedTask('selected', 'git_worktree_add_failed')

    // No attempt row at all: we cannot prove Git did nothing.
    expect(resolveRecoveryAdmission(db(), task)).toEqual({ admissible: false })
  })

  it.each(['claimed', 'created', 'verified', 'failed_ambiguous', 'finalized'] as const)(
    'refuses a retry while a %s attempt survives',
    (status) => {
      const task = blockedTask('selected', 'git_worktree_add_failed')
      seedAttempt(task.id, status)

      expect(resolveRecoveryAdmission(db(), task)).toEqual({ admissible: false })
    }
  )

  it.each(['managed_root_unavailable', 'base_commit_unresolvable', 'worktree_unreadable'] as const)(
    'admits %s only when no attempt was ever claimed',
    (reasonCode) => {
      const task = blockedTask('selected', reasonCode)

      expect(resolveRecoveryAdmission(db(), task)).toEqual({
        admissible: true,
        restoreTo: 'selected'
      })
    }
  )

  // The core of the fix: worktree_unreadable after a SUCCESSFUL worktree-add is
  // recorded as failed_ambiguous, and must never be retried.
  it('refuses worktree_unreadable once an attempt reached failed_ambiguous', () => {
    const task = blockedTask('selected', 'worktree_unreadable')
    seedAttempt(task.id, 'failed_ambiguous')

    expect(resolveRecoveryAdmission(db(), task)).toEqual({ admissible: false })
  })

  it.each(['planning', 'ready_to_implement'] as const)(
    'admits legacy recovery from %s when no attempt evidence exists',
    (preBlockState) => {
      const task = blockedTask(preBlockState, 'worktree_never_provisioned')

      expect(resolveRecoveryAdmission(db(), task)).toEqual({
        admissible: true,
        restoreTo: preBlockState
      })
    }
  )

  it('refuses legacy recovery when attempt evidence exists', () => {
    const task = blockedTask('planning', 'worktree_never_provisioned')
    seedAttempt(task.id, 'failed_ambiguous')

    expect(resolveRecoveryAdmission(db(), task)).toEqual({ admissible: false })
  })

  it.each([
    'provision_evidence_ambiguous',
    'worktree_path_occupied',
    'repository_identity_mismatch',
    'unsupported_host'
  ] as const)('refuses non-retryable evidence %s', (reasonCode) => {
    expect(resolveRecoveryAdmission(db(), blockedTask('selected', reasonCode))).toEqual({
      admissible: false
    })
  })

  it('refuses a mismatched pre_block_state / reason pairing', () => {
    expect(
      resolveRecoveryAdmission(db(), blockedTask('planning', 'git_worktree_add_failed'))
    ).toEqual({ admissible: false })
    expect(
      resolveRecoveryAdmission(db(), blockedTask('selected', 'worktree_never_provisioned'))
    ).toEqual({ admissible: false })
  })

  it('refuses a task that is not blocked', () => {
    expect(resolveRecoveryAdmission(db(), makeTask())).toEqual({ admissible: false })
  })
})

describe('provisioning-failure retry flow', () => {
  it('recovers to selected without invoking the provider, then triages on an explicit start', async () => {
    // A base commit that does not exist: git fails leaving no side effects.
    const task = makeTask({ baseCommit: 'f'.repeat(40) })
    let providerCalls = 0
    setTriageProviderForTests({
      runTriage: async () => {
        providerCalls += 1
        return {
          ok: true,
          output: {
            decision: 'direct',
            risk: 'low',
            rationale: 'ok',
            acceptanceCriteria: [{ id: 'ac1', text: 'works', covered: false }],
            nextStepPrompt: 'go'
          }
        }
      }
    })

    const started = await startTriage(task.id)
    expect(started).toEqual({
      ok: false,
      kind: 'worktree',
      reasonCode: 'git_worktree_add_failed'
    })
    expect(providerCalls).toBe(0)

    const blocked = reload(task.id)
    expect(blocked.state).toBe('blocked')
    expect(blocked.preBlockState).toBe('selected')
    expect(blocked.blockedReasonCode).toBe('worktree_provision_failed')
    expect(blocked.worktreeReasonCode).toBe('git_worktree_add_failed')

    // Repoint at a resolvable base commit, then explicitly recover.
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET base_commit = ? WHERE id = ?`)
      .run(testRepo.headCommit, task.id)

    const recovered = await recoverWorktreeForTask(task.id)
    expect(recovered).toEqual({ ok: true, restoredState: 'selected' })

    const restored = reload(task.id)
    expect(restored.state).toBe('selected')
    expect(restored.blockedReasonCode).toBeNull()
    expect(restored.worktreeReasonCode).toBeNull()
    expect(restored.preBlockState).toBeNull()
    expect(restored.worktreeProvenance).toBe('orca_audited_v1')
    // Recovery NEVER chains into the provider.
    expect(providerCalls).toBe(0)

    // Only the explicit Start Triage runs it — exactly once.
    const second = await startTriage(task.id)
    expect(second).toEqual({ ok: true })
    expect(providerCalls).toBe(1)
    expect(reload(task.id).state).toBe('ready_to_implement')
  })

  it('retryTriage cannot be used to bypass the provisioning-recovery contract', async () => {
    const task = makeTask({ baseCommit: 'f'.repeat(40) })
    let providerCalls = 0
    setTriageProviderForTests({
      runTriage: async () => {
        providerCalls += 1
        return { ok: false, reasonCode: 'provider_error' }
      }
    })
    await startTriage(task.id)
    expect(reload(task.id).preBlockState).toBe('selected')

    const result = await retryTriage(task.id)

    expect(result).toEqual({ ok: false, kind: 'triage', reasonCode: 'illegal_transition' })
    expect(providerCalls).toBe(0)
    const runs = repository
      .getDatabase()
      .prepare(`SELECT id FROM audited_triage_runs WHERE task_id = ?`)
      .all(task.id)
    expect(runs).toHaveLength(0)
  })

  it('refuses recovery for ambiguous evidence and leaves the block in place', async () => {
    const task = makeTask()
    // Pre-create the branch so worktree-add fails with a branch-only remnant.
    const { git } = await import('./audited-worktree-test-repo')
    git(testRepo.repoPath, ['branch', `orca/audited/${task.id}`, testRepo.headCommit])

    const outcome = await ensureWorktreeForTask(task.id)
    expect(outcome).toEqual({ ok: false, reasonCode: 'provision_evidence_ambiguous' })

    const recovered = await recoverWorktreeForTask(task.id)

    expect(recovered).toEqual({ ok: false, notAdmissible: true })
    expect(reload(task.id).state).toBe('blocked')
    expect(reload(task.id).worktreeReasonCode).toBe('provision_evidence_ambiguous')
  })
})

describe('legacy post-triage recovery', () => {
  it('blocks a post-triage task with no worktree and restores it without re-running triage', async () => {
    const task = makeTask()
    // Simulate a Phase 2 task that reached ready_to_implement with no worktree.
    repository
      .getDatabase()
      .prepare(
        `UPDATE audited_tasks SET state = 'ready_to_implement', triage_decision = 'direct',
           triage_run_status = 'succeeded' WHERE id = ?`
      )
      .run(task.id)
    let providerCalls = 0
    setTriageProviderForTests({
      runTriage: async () => {
        providerCalls += 1
        return { ok: false, reasonCode: 'provider_error' }
      }
    })

    const reconciled = await reconcileAuditedWorktreesOnStartup()

    expect(reconciled).toEqual([
      {
        taskId: task.id,
        classification: 'needs_attention',
        reasonCode: 'worktree_never_provisioned'
      }
    ])
    const blocked = reload(task.id)
    expect(blocked.state).toBe('blocked')
    expect(blocked.preBlockState).toBe('ready_to_implement')
    // Provenance stays null: it describes a verified worktree, not migration history.
    expect(blocked.worktreeProvenance).toBeNull()

    const recovered = await recoverWorktreeForTask(task.id)

    expect(recovered).toEqual({ ok: true, restoredState: 'ready_to_implement' })
    const restored = reload(task.id)
    expect(restored.state).toBe('ready_to_implement')
    expect(restored.triageDecision).toBe('direct')
    expect(restored.triageRunStatus).toBe('succeeded')
    expect(restored.worktreeProvenance).toBe('orca_audited_v1')
    expect(providerCalls).toBe(0)
  })

  it('is idempotent across repeated startup passes', async () => {
    const task = makeTask()
    repository
      .getDatabase()
      .prepare(`UPDATE audited_tasks SET state = 'planning' WHERE id = ?`)
      .run(task.id)

    const first = await reconcileAuditedWorktreesOnStartup()
    const second = await reconcileAuditedWorktreesOnStartup()

    expect(first).toHaveLength(1)
    // Already blocked: a second pass must not overwrite the first classification.
    expect(second).toHaveLength(0)
    expect(reload(task.id).preBlockState).toBe('planning')
  })
})

describe('startup reconciliation is read-only', () => {
  it('detects drift on a provisioned worktree without mutating Git', async () => {
    const task = makeTask()
    await ensureWorktreeForTask(task.id)
    const provisioned = reload(task.id)
    const { git, listRefs } = await import('./audited-worktree-test-repo')
    git(provisioned.worktreePath as string, ['checkout', '--detach', testRepo.headCommit])
    const refsBefore = listRefs(testRepo.repoPath)

    const reconciled = await reconcileAuditedWorktreesOnStartup()

    expect(reconciled).toEqual([
      { taskId: task.id, classification: 'failed', reasonCode: 'head_not_symbolic' }
    ])
    expect(listRefs(testRepo.repoPath)).toEqual(refsBefore)
  })
})

// Phase 4 §2. Pins that an EXECUTION-blocked task is not admissible to worktree
// recovery, which is why the failed-retry-preflight path renders no recovery
// button: offering one would promise an action that always returns
// notAdmissible. Also pins that the admission contract itself was NOT widened.
describe('execution-blocked tasks stay inadmissible to worktree recovery', () => {
  function blockByExecution(taskId: string, preBlockState: 'implementing' | 'planning'): void {
    repository
      .getDatabase()
      .prepare(
        `UPDATE audited_tasks
            SET state = 'blocked', pre_block_state = ?,
                blocked_reason_code = 'implement_process_failed',
                blocked_phase = 'execution', worktree_reason_code = NULL
          WHERE id = ?`
      )
      .run(preBlockState, taskId)
  }

  it.each(['implementing', 'planning'] as const)(
    'refuses admission for pre_block_state=%s with a null worktree reason',
    async (preBlockState) => {
      const task = makeTask()
      await ensureWorktreeForTask(task.id)
      blockByExecution(task.id, preBlockState)

      const admission = resolveRecoveryAdmission(repository.getDatabase(), reload(task.id))
      expect(admission).toEqual({ admissible: false })

      const recovered = await recoverWorktreeForTask(task.id)
      expect(recovered).toEqual({ ok: false, notAdmissible: true })
    }
  )

  it('still refuses when a drift reason is present but pre_block_state is implementing', async () => {
    const task = makeTask()
    await ensureWorktreeForTask(task.id)
    // Even with a persisted worktree reason, the implementing pre-block state is
    // outside both admission shapes — and drift codes are never retry-safe.
    repository
      .getDatabase()
      .prepare(
        `UPDATE audited_tasks
            SET state = 'blocked', pre_block_state = 'implementing',
                worktree_reason_code = 'head_moved_from_base_commit'
          WHERE id = ?`
      )
      .run(task.id)

    expect(resolveRecoveryAdmission(repository.getDatabase(), reload(task.id))).toEqual({
      admissible: false
    })
  })

  it('leaves the two existing admission shapes exactly as admissible as before', async () => {
    // Shape 1: provisioning retry from `selected` with a retry-safe reason and
    // no surviving attempt evidence.
    const provisioning = makeTask()
    repository
      .getDatabase()
      .prepare(
        `UPDATE audited_tasks
            SET state = 'blocked', pre_block_state = 'selected',
                worktree_reason_code = 'managed_root_unavailable'
          WHERE id = ?`
      )
      .run(provisioning.id)
    expect(resolveRecoveryAdmission(repository.getDatabase(), reload(provisioning.id))).toEqual({
      admissible: true,
      restoreTo: 'selected'
    })

    // Shape 2: legacy, never-provisioned task in a post-triage state.
    const legacy = makeTask()
    repository
      .getDatabase()
      .prepare(
        `UPDATE audited_tasks
            SET state = 'blocked', pre_block_state = 'ready_to_implement',
                worktree_reason_code = 'worktree_never_provisioned'
          WHERE id = ?`
      )
      .run(legacy.id)
    expect(resolveRecoveryAdmission(repository.getDatabase(), reload(legacy.id))).toEqual({
      admissible: true,
      restoreTo: 'ready_to_implement'
    })
  })
})
