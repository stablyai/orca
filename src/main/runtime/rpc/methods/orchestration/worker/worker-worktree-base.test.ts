import { describe, expect, it } from 'vitest'
import { resolveWorkerWorktreeBaseBranch } from './worker-worktree-creation'

describe('resolveWorkerWorktreeBaseBranch', () => {
  it('uses the explicit base branch when one is requested', () => {
    expect(resolveWorkerWorktreeBaseBranch('origin/release', 'dev')).toBe('origin/release')
  })

  it('uses the parent branch for a child without an explicit base', () => {
    expect(resolveWorkerWorktreeBaseBranch(undefined, 'dev')).toBe('dev')
  })

  it('lets the normal create fallback handle a detached parent', () => {
    expect(resolveWorkerWorktreeBaseBranch(undefined, '')).toBeUndefined()
  })
})
