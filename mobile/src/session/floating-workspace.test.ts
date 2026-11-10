import { describe, expect, it } from 'vitest'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'

describe('floating workspace routing', () => {
  it('matches only the desktop sentinel id', () => {
    expect(isFloatingWorkspaceWorktreeId('global-floating-terminal')).toBe(true)
    expect(isFloatingWorkspaceWorktreeId('repo-1::/worktree')).toBe(false)
    expect(isFloatingWorkspaceWorktreeId('folder:group-1')).toBe(false)
    expect(isFloatingWorkspaceWorktreeId(undefined)).toBe(false)
    expect(isFloatingWorkspaceWorktreeId(null)).toBe(false)
  })
})
