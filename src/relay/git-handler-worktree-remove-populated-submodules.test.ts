import { describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import type { GitExec } from './git-handler-ops'
import { removeWorktreeOp } from './git-handler-worktree-ops'

const SUBMODULE_FATAL = 'fatal: working trees containing submodules cannot be moved or removed'

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

function resolvedRepoPath(): string {
  return path.posix.resolve('/repo-feature', '/repo/.git', '..')
}

function commandText(args: string[], cwd: string): string {
  return `${cwd}$ ${args.join(' ')}`
}

describe('removeWorktreeOp populated submodule retry', () => {
  it('retries with force after a strict clean status check when populated submodules block removal', async () => {
    const calls: string[] = []
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push(commandText(args, cwd))
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
      if (args[0] === 'worktree' && args[1] === 'remove' && !args.includes('--force')) {
        throw new Error(SUBMODULE_FATAL)
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeOp(git, { worktreePath: '/repo-feature', deleteBranch: false })

    expect(calls).toEqual([
      '/repo-feature$ rev-parse --git-common-dir',
      `${resolvedRepoPath()}$ worktree list --porcelain -z`,
      `${resolvedRepoPath()}$ worktree remove /repo-feature`,
      '/repo-feature$ status --porcelain --untracked-files=all --ignore-submodules=none',
      `${resolvedRepoPath()}$ worktree remove --force /repo-feature`
    ])
  })

  it('does not force retry when strict status shows hidden dirty submodule content', async () => {
    const removalError = new Error(SUBMODULE_FATAL)
    const calls: string[] = []
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push(commandText(args, cwd))
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          stdout: worktreeList({ path: '/repo-feature', branch: 'feature/test' }),
          stderr: ''
        }
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw removalError
      }
      if (args[0] === 'status') {
        return { stdout: ' m submodule\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(removeWorktreeOp(git, { worktreePath: '/repo-feature' })).rejects.toBe(
      removalError
    )

    expect(calls).toEqual([
      '/repo-feature$ rev-parse --git-common-dir',
      `${resolvedRepoPath()}$ worktree list --porcelain -z`,
      `${resolvedRepoPath()}$ worktree remove /repo-feature`,
      '/repo-feature$ status --porcelain --untracked-files=all --ignore-submodules=none'
    ])
    expect(calls).not.toContain(`${resolvedRepoPath()}$ worktree remove --force /repo-feature`)
  })

  it('rethrows unrelated remove errors without status check or force retry', async () => {
    const unrelatedError = new Error('fatal: /repo-feature is a main working tree')
    const calls: string[] = []
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push(commandText(args, cwd))
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          stdout: worktreeList({ path: '/repo-feature', branch: 'feature/test' }),
          stderr: ''
        }
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw unrelatedError
      }
      return { stdout: '', stderr: '' }
    })

    await expect(removeWorktreeOp(git, { worktreePath: '/repo-feature' })).rejects.toBe(
      unrelatedError
    )

    expect(calls).toEqual([
      '/repo-feature$ rev-parse --git-common-dir',
      `${resolvedRepoPath()}$ worktree list --porcelain -z`,
      `${resolvedRepoPath()}$ worktree remove /repo-feature`
    ])
  })

  it('continues into branch cleanup after the populated submodule force retry succeeds', async () => {
    const calls: string[] = []
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push(commandText(args, cwd))
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
      if (args[0] === 'worktree' && args[1] === 'remove' && !args.includes('--force')) {
        throw new Error(SUBMODULE_FATAL)
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeOp(git, { worktreePath: '/repo-feature' })

    expect(calls).toEqual([
      '/repo-feature$ rev-parse --git-common-dir',
      `${resolvedRepoPath()}$ worktree list --porcelain -z`,
      `${resolvedRepoPath()}$ worktree remove /repo-feature`,
      '/repo-feature$ status --porcelain --untracked-files=all --ignore-submodules=none',
      `${resolvedRepoPath()}$ worktree remove --force /repo-feature`,
      `${resolvedRepoPath()}$ branch -d -- feature/test`
    ])
  })
})
