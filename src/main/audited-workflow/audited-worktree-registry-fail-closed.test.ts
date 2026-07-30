// Fail-closed registry initialization.
//
// If the durable sources cannot be loaded, the guard cannot know which
// worktrees are audited. Continuing with an empty registry would silently
// disable protection for every existing audited worktree, so every mutation
// boundary must refuse instead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import {
  AUDITED_WORKTREE_REFUSAL_MESSAGE,
  AUDITED_WORKTREE_REGISTRY_UNAVAILABLE_MESSAGE,
  AuditedWorktreeRegistryUnavailableError,
  assertGitMutationAllowed,
  auditedWorktreeRefusalResult,
  isAuditedWorktreeGitMutationRefused
} from './audited-worktree-authority-guard'
import {
  isAuditedWorktreeRegistryReady,
  resetAuditedWorktreeRegistryStateForTests
} from './audited-worktree-registry'
import { rebuildRegistryFromDatabase } from './audited-worktree-attempt-repository'
import { rebuildAuditedWorktreeRegistry } from './audited-worktree-service'

const ORDINARY = process.platform === 'win32' ? 'C:\\ws\\feature-x' : '/ws/feature-x'

let repository: AuditedTaskRepository

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  resetAuditedWorktreeRegistryStateForTests()
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  resetAuditedWorktreeRegistryStateForTests()
  vi.restoreAllMocks()
})

/** Makes the rebuild query throw, simulating an unreadable/corrupt database. */
function breakRebuildQuery(): void {
  vi.spyOn(repository, 'getDatabase').mockImplementation(() => {
    throw new Error('SQLITE_CORRUPT: database disk image is malformed at /home/u/.orca/audited.db')
  })
}

describe('registry initialization fails closed', () => {
  // Before Audited Workflow is wired up in a process there are no audited
  // worktrees to protect, so ordinary Git work proceeds. Once
  // rebuildAuditedWorktreeRegistry() has been called the guard's answer must
  // come from a real rebuild.
  it('does not refuse ordinary work in a process that never initializes the feature', () => {
    expect(isAuditedWorktreeRegistryReady()).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(false)
  })

  it('refuses ordinary worktree mutation once initialization is required but incomplete', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    breakRebuildQuery()
    rebuildAuditedWorktreeRegistry()

    expect(isAuditedWorktreeRegistryReady()).toBe(false)
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(true)
    expect(() => assertGitMutationAllowed(ORDINARY)).toThrow(
      AuditedWorktreeRegistryUnavailableError
    )
  })

  it('stays unavailable after a rebuild failure', () => {
    breakRebuildQuery()

    const result = rebuildAuditedWorktreeRegistry()

    expect(result).toEqual({ ok: false })
    expect(isAuditedWorktreeRegistryReady()).toBe(false)
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(true)
  })

  it('never exposes the underlying database error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    breakRebuildQuery()
    rebuildAuditedWorktreeRegistry()

    const thrown = (() => {
      try {
        assertGitMutationAllowed(ORDINARY)
        return null
      } catch (error) {
        return error as Error
      }
    })()

    for (const text of [thrown?.message ?? '', auditedWorktreeRefusalResult().error]) {
      expect(text).toBe(AUDITED_WORKTREE_REGISTRY_UNAVAILABLE_MESSAGE)
      expect(text).not.toContain('SQLITE')
      expect(text).not.toContain('malformed')
      expect(text).not.toContain('.orca')
      expect(text).not.toContain('audited.db')
    }
  })

  it('restores ordinary mutation once a later rebuild succeeds', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    breakRebuildQuery()
    rebuildAuditedWorktreeRegistry()
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(true)

    vi.restoreAllMocks()
    const retry = rebuildAuditedWorktreeRegistry()

    expect(retry).toEqual({ ok: true })
    expect(isAuditedWorktreeRegistryReady()).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(false)
    expect(() => assertGitMutationAllowed(ORDINARY)).not.toThrow()
  })

  it('distinguishes the unavailable message from the audited-worktree refusal', () => {
    rebuildAuditedWorktreeRegistry()

    expect(auditedWorktreeRefusalResult().error).toBe(AUDITED_WORKTREE_REFUSAL_MESSAGE)
    expect(AUDITED_WORKTREE_REGISTRY_UNAVAILABLE_MESSAGE).not.toBe(
      AUDITED_WORKTREE_REFUSAL_MESSAGE
    )
  })
})

// A previously-successful rebuild leaves a `ready` snapshot that cannot contain
// any audited worktree created since. Retaining it after a later query failure
// would permit mutation of that newer worktree, so a failed rebuild must drop
// the cached paths and go unavailable even when it was previously ready.
describe('a failed rebuild never retains a stale ready snapshot', () => {
  const PATH_A =
    process.platform === 'win32' ? 'C:\\ws\\.orca-audited\\r1\\ta' : '/ws/.orca-audited/r1/ta'
  const PATH_B =
    process.platform === 'win32' ? 'C:\\ws\\.orca-audited\\r1\\tb' : '/ws/.orca-audited/r1/tb'

  // Stands in for the Git primitive each guarded route would call after the
  // guard permits the mutation.
  const gitPrimitive = vi.fn()

  function seedAuditedTask(taskId: string, worktreePath: string): void {
    repository.getDatabase().prepare(
      `INSERT INTO audited_tasks (id, repo_id, source_repo_path, worktree_path, branch_name,
         base_commit, host_id, title, spec_json, source, risk, state, plan_round, fix_round,
         worktree_provenance, created_at_ms, updated_at_ms)
       VALUES (?, 'repo1', '/repos/one', ?, 'orca/audited/b', 'aaa', 'local', 't', '{}',
         'custom', 'low', 'selected', 0, 0, 'orca_audited_v1', 1, 1)`
    ).run(taskId, worktreePath)
  }

  /** Fails ONLY the second durable source, leaving the first readable. */
  function breakAttemptsQueryOnly(): void {
    const realDb = repository.getDatabase()
    const realPrepare = realDb.prepare.bind(realDb)
    vi.spyOn(repository, 'getDatabase').mockReturnValue({
      ...realDb,
      prepare: (sql: string) => {
        if (sql.includes('audited_worktree_attempts')) {
          throw new Error('SQLITE_IOERR: disk I/O error reading /home/u/.orca/audited.db')
        }
        return realPrepare(sql)
      }
    } as never)
  }

  beforeEach(() => {
    gitPrimitive.mockClear()
  })

  it('drops path A, refuses new path B, and refuses ordinary routes after a query failure', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // 1. A successful rebuild containing path A.
    seedAuditedTask('audited_a', PATH_A)
    expect(rebuildAuditedWorktreeRegistry()).toEqual({ ok: true })
    expect(isAuditedWorktreeRegistryReady()).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(PATH_A)).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(false)

    // 2. A newer audited worktree B exists, but one durable source now fails.
    seedAuditedTask('audited_b', PATH_B)
    breakAttemptsQueryOnly()

    const result = rebuildAuditedWorktreeRegistry()

    // 3. Unavailable — not a stale ready snapshot.
    expect(result).toEqual({ ok: false })
    expect(isAuditedWorktreeRegistryReady()).toBe(false)
    // Both the previously-known A and the newly-created B are refused...
    expect(isAuditedWorktreeGitMutationRefused(PATH_A)).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(PATH_B)).toBe(true)
    // ...as are ordinary routes, since membership is unknowable.
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(true)

    // No Git primitive runs behind any guarded boundary.
    for (const target of [PATH_A, PATH_B, ORDINARY]) {
      expect(() => {
        assertGitMutationAllowed(target)
        gitPrimitive()
      }).toThrow(AuditedWorktreeRegistryUnavailableError)
    }
    expect(gitPrimitive).not.toHaveBeenCalled()

    // No raw database error escapes to any surface.
    for (const text of [
      auditedWorktreeRefusalResult().error,
      (() => {
        try {
          assertGitMutationAllowed(ORDINARY)
          return ''
        } catch (error) {
          return (error as Error).message
        }
      })()
    ]) {
      expect(text).toBe(AUDITED_WORKTREE_REGISTRY_UNAVAILABLE_MESSAGE)
      expect(text).not.toContain('SQLITE')
      expect(text).not.toContain('disk I/O')
      expect(text).not.toContain('audited.db')
      expect(text).not.toContain(PATH_B)
    }

    // 4. A later successful rebuild restores normal behavior, now including B.
    vi.restoreAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(rebuildAuditedWorktreeRegistry()).toEqual({ ok: true })
    expect(isAuditedWorktreeRegistryReady()).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(PATH_A)).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(PATH_B)).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(false)

    gitPrimitive.mockClear()
    expect(() => {
      assertGitMutationAllowed(ORDINARY)
      gitPrimitive()
    }).not.toThrow()
    expect(gitPrimitive).toHaveBeenCalledTimes(1)
  })

  // rebuildRegistryFromDatabase is called directly by reconciliation and by
  // restart paths that do NOT go through the service wrapper's catch, so the
  // fail-closed guarantee has to live in the repository function itself.
  it('fails closed at the repository level, without the service wrapper catching', () => {
    seedAuditedTask('audited_a', PATH_A)
    rebuildRegistryFromDatabase(repository.getDatabase())
    expect(isAuditedWorktreeRegistryReady()).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(false)

    seedAuditedTask('audited_b', PATH_B)
    const realDb = repository.getDatabase()
    const realPrepare = realDb.prepare.bind(realDb)
    const brokenDb = {
      ...realDb,
      prepare: (sql: string) => {
        if (sql.includes('audited_worktree_attempts')) {
          throw new Error('SQLITE_IOERR: disk I/O error')
        }
        return realPrepare(sql)
      }
    } as never

    expect(() => rebuildRegistryFromDatabase(brokenDb)).toThrow(/SQLITE_IOERR/)

    // The stale ready snapshot must NOT survive the throw.
    expect(isAuditedWorktreeRegistryReady()).toBe(false)
    expect(isAuditedWorktreeGitMutationRefused(PATH_A)).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(PATH_B)).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(true)
  })

  it('fails closed when the FIRST durable source is the one that fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    seedAuditedTask('audited_a', PATH_A)
    rebuildAuditedWorktreeRegistry()
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(false)

    const realDb = repository.getDatabase()
    const realPrepare = realDb.prepare.bind(realDb)
    vi.spyOn(repository, 'getDatabase').mockReturnValue({
      ...realDb,
      prepare: (sql: string) => {
        if (sql.includes('audited_tasks')) {
          throw new Error('SQLITE_IOERR: disk I/O error')
        }
        return realPrepare(sql)
      }
    } as never)

    expect(rebuildAuditedWorktreeRegistry()).toEqual({ ok: false })
    expect(isAuditedWorktreeRegistryReady()).toBe(false)
    expect(isAuditedWorktreeGitMutationRefused(PATH_A)).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(true)
  })
})
