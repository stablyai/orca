import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AUDITED_WORKTREE_REFUSAL_MESSAGE,
  AuditedWorktreeAuthorityError,
  assertGitMutationAllowed,
  auditedWorktreeRefusalResult,
  isAuditedWorktreeGitMutationRefused
} from './audited-worktree-authority-guard'
import {
  clearAuditedWorktreeRegistryForTests,
  publishAuditedWorktreePath
} from './audited-worktree-registry'

const AUDITED = process.platform === 'win32' ? 'C:\\ws\\.orca-audited\\r1\\t1' : '/ws/.orca-audited/r1/t1'
const ORDINARY = process.platform === 'win32' ? 'C:\\ws\\feature-x' : '/ws/feature-x'

// These cases exercise membership, which is only meaningful once the registry is
// ready; the fail-closed (not-ready) behavior is covered by
// audited-worktree-registry-fail-closed.test.ts.
beforeEach(() => {
  clearAuditedWorktreeRegistryForTests()
})

afterEach(() => {
  clearAuditedWorktreeRegistryForTests()
})

describe('audited worktree authority guard', () => {
  it('refuses a guarded path and permits an ordinary one', () => {
    publishAuditedWorktreePath(AUDITED)

    expect(isAuditedWorktreeGitMutationRefused(AUDITED)).toBe(true)
    expect(isAuditedWorktreeGitMutationRefused(ORDINARY)).toBe(false)
    expect(() => assertGitMutationAllowed(AUDITED)).toThrow(AuditedWorktreeAuthorityError)
    expect(() => assertGitMutationAllowed(ORDINARY)).not.toThrow()
  })

  it('treats missing and empty paths as not audited', () => {
    expect(isAuditedWorktreeGitMutationRefused(undefined)).toBe(false)
    expect(isAuditedWorktreeGitMutationRefused(null)).toBe(false)
    expect(isAuditedWorktreeGitMutationRefused('')).toBe(false)
  })

  it('never leaks a path, branch, task id, or evidence in the refusal', () => {
    publishAuditedWorktreePath(AUDITED)

    const thrown = (() => {
      try {
        assertGitMutationAllowed(AUDITED)
        return null
      } catch (error) {
        return error as Error
      }
    })()

    const surfaces = [thrown?.message ?? '', auditedWorktreeRefusalResult().error]
    for (const text of surfaces) {
      expect(text).toBe(AUDITED_WORKTREE_REFUSAL_MESSAGE)
      expect(text).not.toContain('.orca-audited')
      expect(text).not.toContain('t1')
      expect(text).not.toContain('orca/audited')
    }
  })

  it('matches case-insensitively on win32 only', () => {
    publishAuditedWorktreePath(AUDITED)
    const swapped = AUDITED.toUpperCase()

    expect(isAuditedWorktreeGitMutationRefused(swapped)).toBe(process.platform === 'win32')
  })

  it('returns the structured refusal shape for result-shaped surfaces', () => {
    expect(auditedWorktreeRefusalResult()).toEqual({
      success: false,
      error: AUDITED_WORKTREE_REFUSAL_MESSAGE
    })
  })
})
