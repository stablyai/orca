import { describe, expect, it, vi } from 'vitest'
import type { GitExec } from './git-handler-ops'
import { worktreeIsCleanOp } from './git-handler-worktree-ops'

describe('worktreeIsCleanOp', () => {
  it('reports clean SSH worktrees without returning porcelain output', async () => {
    const git = vi.fn<GitExec>(async () => ({ stdout: '\n', stderr: '' }))

    await expect(worktreeIsCleanOp(git, { worktreePath: '/repo-feature' })).resolves.toEqual({
      clean: true,
      stdout: undefined
    })

    expect(git).toHaveBeenCalledWith(
      ['status', '--porcelain', '--untracked-files=all'],
      '/repo-feature'
    )
  })

  it('returns porcelain output for dirty SSH worktrees', async () => {
    const stdout = ' M src/file.ts\n?? scratch.txt\n'
    const git = vi.fn<GitExec>(async () => ({ stdout, stderr: '' }))

    await expect(worktreeIsCleanOp(git, { worktreePath: '/repo-feature' })).resolves.toEqual({
      clean: false,
      stdout
    })
  })
})
