import { describe, expect, it } from 'vitest'
import { planWorktreeFolderRename } from './worktree-folder-rename-target'

describe('planWorktreeFolderRename', () => {
  const base = {
    repoId: 'repo1',
    repoPath: '/repos/orca',
    settings: { nestWorkspaces: false, workspaceDir: '/ws' },
    platform: 'darwin' as NodeJS.Platform,
    isRemote: false
  }

  it('plans a same-parent rename to the new branch leaf', () => {
    expect(
      planWorktreeFolderRename({
        ...base,
        oldWorktreePath: '/ws/cunner',
        newLeaf: 'worktree-creation-spinner'
      })
    ).toEqual({
      oldPath: '/ws/cunner',
      newPath: '/ws/worktree-creation-spinner',
      newWorktreeId: 'repo1::/ws/worktree-creation-spinner'
    })
  })

  it('skips remote worktrees (SSH folder moves are not mirrored)', () => {
    expect(
      planWorktreeFolderRename({
        ...base,
        isRemote: true,
        oldWorktreePath: '/ws/cunner',
        newLeaf: 'fix-auth'
      })
    ).toBeNull()
  })

  it('skips on Windows (the OS locks the running agent cwd)', () => {
    expect(
      planWorktreeFolderRename({
        ...base,
        platform: 'win32',
        oldWorktreePath: '/ws/cunner',
        newLeaf: 'fix-auth'
      })
    ).toBeNull()
  })

  it('skips when the folder name already matches the leaf', () => {
    expect(
      planWorktreeFolderRename({
        ...base,
        oldWorktreePath: '/ws/fix-auth',
        newLeaf: 'fix-auth'
      })
    ).toBeNull()
  })

  it('skips when settings would relocate to a different parent (not a rename)', () => {
    expect(
      planWorktreeFolderRename({
        ...base,
        oldWorktreePath: '/somewhere/else/cunner',
        newLeaf: 'fix-auth'
      })
    ).toBeNull()
  })
})
