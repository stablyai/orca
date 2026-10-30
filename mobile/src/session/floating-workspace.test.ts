import { describe, expect, it } from 'vitest'
import {
  FLOATING_WORKSPACE_WORKTREE_ID,
  floatingWorkspaceSessionPath,
  isFloatingWorkspaceWorktreeId
} from './floating-workspace'

describe('floating workspace routing', () => {
  it('matches only the desktop sentinel id', () => {
    expect(isFloatingWorkspaceWorktreeId('global-floating-terminal')).toBe(true)
    expect(isFloatingWorkspaceWorktreeId('repo-1::/worktree')).toBe(false)
    expect(isFloatingWorkspaceWorktreeId('folder:group-1')).toBe(false)
    expect(isFloatingWorkspaceWorktreeId(undefined)).toBe(false)
    expect(isFloatingWorkspaceWorktreeId(null)).toBe(false)
  })

  it('builds the session route with an explicit title seed', () => {
    expect(floatingWorkspaceSessionPath('host-1')).toBe(
      `/h/host-1/session/${FLOATING_WORKSPACE_WORKTREE_ID}?name=Floating%20Workspace`
    )
  })
})
