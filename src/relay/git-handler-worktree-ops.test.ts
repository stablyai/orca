import { describe, expect, it, vi } from 'vitest'
import type { GitExec } from './git-handler-ops'
import { removeWorktreeOp } from './git-handler-worktree-ops'

function worktreeList(...entries: { path: string; branch?: string }[]): string {
  return entries
    .map((entry, index) =>
      [
        `worktree ${entry.path}`,
        `HEAD ${index}`,
        ...(entry.branch ? [`branch refs/heads/${entry.branch}`] : [])
      ].join('\n')
    )
    .join('\n\n')
}

describe('removeWorktreeOp', () => {
  it('deletes the now-unused branch after removing an SSH worktree', async () => {
    const calls: string[] = []
    let listCount = 0
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push(`${cwd}$ ${args.join(' ')}`)
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCount += 1
        return {
          stdout:
            listCount === 1
              ? worktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-feature', branch: 'feature/test' }
                )
              : worktreeList({ path: '/repo', branch: 'main' }),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeOp(git, { worktreePath: '/repo-feature' })

    expect(calls).toEqual([
      '/repo-feature$ rev-parse --git-common-dir',
      '/repo$ worktree list --porcelain',
      '/repo$ worktree remove /repo-feature',
      '/repo$ worktree prune',
      '/repo$ worktree list --porcelain',
      '/repo$ branch -D feature/test'
    ])
  })

  it('preserves the branch when removing an SSH worktree for an existing local branch', async () => {
    const calls: string[] = []
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push(`${cwd}$ ${args.join(' ')}`)
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          stdout: worktreeList(
            { path: '/repo', branch: 'main' },
            { path: '/repo-feature', branch: 'feature/test' }
          ),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeOp(git, { worktreePath: '/repo-feature', deleteBranch: false })

    expect(calls).toEqual([
      '/repo-feature$ rev-parse --git-common-dir',
      '/repo$ worktree list --porcelain',
      '/repo$ worktree remove /repo-feature',
      '/repo$ worktree prune'
    ])
  })

  it('keeps the branch when another SSH worktree still uses it', async () => {
    let listCount = 0
    const git = vi.fn<GitExec>(async (args, _cwd) => {
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCount += 1
        return {
          stdout:
            listCount === 1
              ? worktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-feature', branch: 'feature/test' }
                )
              : worktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-other', branch: 'feature/test' }
                ),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeOp(git, { worktreePath: '/repo-feature' })

    expect(git).not.toHaveBeenCalledWith(['branch', '-D', 'feature/test'], expect.any(String))
  })
})
