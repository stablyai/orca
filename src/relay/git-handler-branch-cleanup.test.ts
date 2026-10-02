import { describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import { GitCapabilityCache } from '../shared/git-capability-cache'
import type { GitExec } from './git-handler-ops'
import { removeWorktreeOp } from './git-handler-worktree-ops'
import { forceDeletePreservedRelayBranch } from './git-handler-branch-cleanup'

function removeWorktreeWithCapabilityCache(
  git: GitExec,
  params: Parameters<typeof removeWorktreeOp>[1]
) {
  return removeWorktreeOp(git, params, new GitCapabilityCache())
}

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

describe('forceDeletePreservedRelayBranch', () => {
  it('deletes a preserved branch at the expected head', async () => {
    const calls: string[][] = []
    const git = vi.fn<GitExec>(async (args) => {
      calls.push(args)
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList({ path: '/repo', branch: 'main' }), stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      forceDeletePreservedRelayBranch(git, '/repo', 'feature/test', 'abc123')
    ).resolves.toBeUndefined()

    expect(calls).toEqual([
      ['worktree', 'list', '--porcelain'],
      ['update-ref', '-d', 'refs/heads/feature/test', 'abc123'],
      ['worktree', 'list', '--porcelain'],
      ['config', '--remove-section', 'branch.feature/test']
    ])
  })

  it('maps only ref-moved update-ref delete failures to the preserved-branch message', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList({ path: '/repo', branch: 'main' }), stderr: '' }
      }
      if (args[0] === 'update-ref' && args[1] === '-d') {
        throw new Error('cannot lock ref')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      forceDeletePreservedRelayBranch(git, '/repo', 'feature/test', 'abc123')
    ).rejects.toThrow(
      'Local branch "feature/test" changed after the workspace was deleted. Review it before deleting it.'
    )
    expect(git).not.toHaveBeenCalledWith(
      ['config', '--remove-section', 'branch.feature/test'],
      '/repo'
    )
  })

  it('keeps the checked-out message when the branch is checked out before delete', async () => {
    const git = vi.fn<GitExec>(async (args) => {
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

    await expect(
      forceDeletePreservedRelayBranch(git, '/repo', 'feature/test', 'abc123')
    ).rejects.toThrow('Local branch "feature/test" is checked out in another worktree.')
    expect(git).not.toHaveBeenCalledWith(
      ['update-ref', '-d', 'refs/heads/feature/test', 'abc123'],
      '/repo'
    )
  })

  it('restores the ref and keeps the checked-out message after a concurrent checkout', async () => {
    let listCount = 0
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCount += 1
        return {
          stdout:
            listCount === 1
              ? worktreeList({ path: '/repo', branch: 'main' })
              : worktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-feature', branch: 'feature/test' }
                ),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      forceDeletePreservedRelayBranch(git, '/repo', 'feature/test', 'abc123')
    ).rejects.toThrow('Local branch "feature/test" is checked out in another worktree.')
    expect(git).toHaveBeenCalledWith(
      ['update-ref', '-d', 'refs/heads/feature/test', 'abc123'],
      '/repo'
    )
    expect(git).toHaveBeenCalledWith(
      ['update-ref', 'refs/heads/feature/test', 'abc123', ''],
      '/repo'
    )
  })

  it('swallows branch config removal failures after deleting the ref', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList({ path: '/repo', branch: 'main' }), stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--remove-section') {
        throw new Error('missing section')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      forceDeletePreservedRelayBranch(git, '/repo', 'feature/test', 'abc123')
    ).resolves.toBeUndefined()
  })

  it.each([
    ['empty branch name', '', 'abc123'],
    ['empty expected head', 'feature/test', ''],
    ['leading dash branch name', '-feature', 'abc123'],
    ['NUL branch name', 'feature\0test', 'abc123']
  ])('rejects invalid input: %s', async (_label, branchName, expectedHead) => {
    const git = vi.fn<GitExec>()

    await expect(
      forceDeletePreservedRelayBranch(git, '/repo', branchName, expectedHead)
    ).rejects.toThrow()
    expect(git).not.toHaveBeenCalled()
  })
})

describe('removeWorktreeOp branch cleanup', () => {
  it('keeps a branch Git refuses to delete and runs no merge proof or fetch', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let zListCount = 0
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list' && args.includes('-z')) {
        zListCount += 1
        return {
          stdout:
            zListCount === 1
              ? worktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-feature', branch: 'feature/test' }
                )
              : worktreeList({ path: '/repo', branch: 'main' }),
          stderr: ''
        }
      }
      if (args[0] === 'branch' && args[1] === '-d') {
        throw new Error('error: the branch feature/test is not fully merged')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })
    ).resolves.toEqual({
      preservedBranch: { branchName: 'feature/test', head: '1' }
    })

    const commands = git.mock.calls.map(([args]) => args[0])
    expect(commands.at(-1)).toBe('branch')
    for (const command of ['merge-tree', 'cherry', 'patch-id', 'fetch', 'update-ref']) {
      expect(commands).not.toContain(command)
    }
    expect(git).toHaveBeenCalledWith(['branch', '-d', '--', 'feature/test'], resolvedRepoPath())
    warnSpy.mockRestore()
  })
})
