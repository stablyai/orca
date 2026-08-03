// Phase 4 Git boundary: prevention plus authoritative detection, NOT containment.
//
// The launch denylist is best-effort and provably incomplete (see
// audited-claude-launch-plan-bypass.test.ts). What actually holds the boundary
// is post-run verification, which is STATE-based — it compares real HEAD and
// branch tip against the persisted base commit — so it catches a commit made by
// any route, including ones the denylist cannot stop.
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
import { clearAuditedWorktreeRegistryForTests } from './audited-worktree-registry'
import {
  ensureWorktreeForTask,
  setAuditedWorktreeStore,
  verifyWorktreeForTask
} from './audited-worktree-service'
import { createTestRepo, git, type TestRepo } from './audited-worktree-test-repo'
import { decideExecutionOutcome } from './audited-execution-outcome'
import { DENIED_GIT_TOOL_PATTERNS } from './audited-claude-launch-plan'

let testRepo: TestRepo
let repository: AuditedTaskRepository

function makeTask(): string {
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

async function provisionedWorktree(): Promise<{ taskId: string; worktreePath: string }> {
  const taskId = makeTask()
  await ensureWorktreeForTask(taskId)
  return { taskId, worktreePath: String(repository.getTask(taskId)?.worktreePath) }
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

describe('drift detection is state-based, so route does not matter', () => {
  it('detects a plain in-worktree commit', async () => {
    const { taskId, worktreePath } = await provisionedWorktree()
    git(worktreePath, ['commit', '-q', '--allow-empty', '-m', 'x'])

    expect(await verifyWorktreeForTask(taskId)).toEqual({
      ok: false,
      reasonCode: 'head_moved_from_base_commit'
    })
  })

  it('detects a commit made via `git -C`, which the denylist cannot stop', async () => {
    const { taskId, worktreePath } = await provisionedWorktree()
    // Deliberately the exact documented bypass vector: run from elsewhere with -C.
    git(testRepo.repoPath, ['-C', worktreePath, 'commit', '-q', '--allow-empty', '-m', 'bypass'])

    expect(await verifyWorktreeForTask(taskId)).toEqual({
      ok: false,
      reasonCode: 'head_moved_from_base_commit'
    })
  })

  it('detects a detached HEAD', async () => {
    const { taskId, worktreePath } = await provisionedWorktree()
    git(worktreePath, ['checkout', '--detach', testRepo.headCommit])

    expect(await verifyWorktreeForTask(taskId)).toEqual({
      ok: false,
      reasonCode: 'head_not_symbolic'
    })
  })

  it('detects a branch switch', async () => {
    const { taskId, worktreePath } = await provisionedWorktree()
    git(worktreePath, ['checkout', '-q', '-b', 'other'])

    expect(await verifyWorktreeForTask(taskId)).toEqual({
      ok: false,
      reasonCode: 'head_branch_mismatch'
    })
  })
})

describe('drift blocks the task instead of advancing it', () => {
  it.each(['head_moved_from_base_commit', 'branch_tip_moved_from_base_commit'] as const)(
    '%s produces unexpected_commit_detected and never awaiting_code_audit',
    (driftReasonCode) => {
      const decision = decideExecutionOutcome({
        mode: 'direct',
        activeRunState: 'implementing',
        outcome: { kind: 'exit', exitCode: 0, stdout: 'done', stderr: '' },
        driftReasonCode,
        hasStdout: true
      })

      expect(decision.reasonCode).toBe('unexpected_commit_detected')
      expect(decision.blockedReasonCode).toBe('unexpected_commit_detected')
      expect(decision.toState).toBe('blocked')
      expect(decision.toState).not.toBe('awaiting_code_audit')
    }
  )

  it('blocks a plan run that drifted, never advancing to awaiting_plan_review', () => {
    const decision = decideExecutionOutcome({
      mode: 'plan',
      activeRunState: 'planning',
      outcome: { kind: 'exit', exitCode: 0, stdout: 'a plan', stderr: '' },
      driftReasonCode: 'head_moved_from_base_commit',
      hasStdout: true
    })

    expect(decision.toState).toBe('blocked')
    expect(decision.toState).not.toBe('awaiting_plan_review')
  })
})

describe('Phase 4 itself issues no Git mutation', () => {
  it('verification runs only read-only argv', async () => {
    const { taskId } = await provisionedWorktree()
    gitExecFileAsyncSpy.mockClear()

    await verifyWorktreeForTask(taskId)

    const mutatingVerbs = [
      'commit',
      'push',
      'merge',
      'rebase',
      'reset',
      'checkout',
      'stash',
      'clean'
    ]
    for (const [argv] of gitExecFileAsyncSpy.mock.calls) {
      for (const verb of mutatingVerbs) {
        expect((argv as string[]).includes(verb), `mutating argv: ${argv}`).toBe(false)
      }
    }
  })

  it('the denylist names every verb Phase 4 refuses to issue itself', () => {
    for (const verb of ['commit', 'push', 'merge', 'rebase']) {
      expect(DENIED_GIT_TOOL_PATTERNS).toContain(`Bash(git ${verb}:*)`)
    }
  })
})
