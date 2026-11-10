import { describe, expect, it } from 'vitest'
import { isSyntheticWorkspaceRoute } from './synthetic-workspace-route'
import { shouldBounceMissingWorktree } from './use-missing-worktree-bounce'

describe('shouldBounceMissingWorktree', () => {
  it('bounces only a host-proven missing worktree', () => {
    expect(shouldBounceMissingWorktree('repo::wt', 'missing')).toBe(true)
    expect(shouldBounceMissingWorktree('repo::wt', 'unknown')).toBe(false)
    expect(shouldBounceMissingWorktree('repo::wt', 'present')).toBe(false)
  })

  it('never bounces synthetic routes the host cannot resolve', () => {
    expect(isSyntheticWorkspaceRoute('folder:/Users/x/dir')).toBe(true)
    expect(shouldBounceMissingWorktree('folder:/Users/x/dir', 'missing')).toBe(false)
    expect(shouldBounceMissingWorktree('global-floating-terminal', 'missing')).toBe(false)
  })
})
