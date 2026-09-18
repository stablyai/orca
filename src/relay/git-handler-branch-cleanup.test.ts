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
  it.each([false, true])(
    'prunes stale checkout registrations before deletion (prune fails: %s)',
    async (pruneFails) => {
      let pruned = false
      const git = vi.fn<GitExec>(async (args) => {
        if (args.join(' ') === 'rev-parse --git-common-dir') {
          return { stdout: '/repo/.git\n', stderr: '' }
        }
        if (args.join(' ') === 'rev-parse --verify --quiet HEAD^{commit}') {
          return { stdout: 'base123\n', stderr: '' }
        }
        if (args.join(' ') === 'merge-base base123 1') {
          return { stdout: '1\n', stderr: '' }
        }
        if (args[0] === 'worktree' && args[1] === 'list') {
          return {
            stdout: worktreeList(
              { path: '/repo', branch: 'main' },
              ...(args.includes('-z')
                ? [{ path: '/repo-feature', branch: 'feature/test' }]
                : pruned
                  ? []
                  : [{ path: '/repo-stale', branch: 'feature/test' }])
            ),
            stderr: ''
          }
        }
        if (args.join(' ') === 'worktree prune') {
          if (pruneFails) {
            throw new Error('prune failed')
          }
          pruned = true
        }
        return { stdout: '', stderr: '' }
      })

      await expect(
        removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })
      ).resolves.toEqual(
        pruneFails ? { preservedBranch: { branchName: 'feature/test', head: '1' } } : {}
      )

      expect(git).toHaveBeenCalledWith(['worktree', 'prune'], resolvedRepoPath())
      const deletion = ['update-ref', '-d', 'refs/heads/feature/test', '1']
      if (pruneFails) {
        expect(git).not.toHaveBeenCalledWith(deletion, resolvedRepoPath())
      } else {
        expect(git).toHaveBeenCalledWith(deletion, resolvedRepoPath())
        expect(
          git.mock.calls.filter(([args]) => args.join(' ') === 'worktree list --porcelain')
        ).toHaveLength(3)
      }
    }
  )

  it('deletes a squash-merged SSH branch when merging it into the base is a no-op', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list' && args.includes('-z')) {
        return {
          stdout: worktreeList(
            { path: '/repo', branch: 'main' },
            { path: '/repo-feature', branch: 'feature/test' }
          ),
          stderr: ''
        }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList({ path: '/repo', branch: 'main' }), stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--get') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
        return { stdout: 'base123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD^{commit}')) {
        return { stdout: 'base123\n', stderr: '' }
      }
      if (args[0] === 'merge-tree') {
        return { stdout: 'tree123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('base123^{tree}')) {
        return { stdout: 'tree123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })
    ).resolves.toEqual({})

    expect(git).not.toHaveBeenCalledWith(['branch', '-d', '--', 'feature/test'], expect.any(String))
    expect(git).toHaveBeenCalledWith(
      ['merge-tree', '--write-tree', 'base123', '1'],
      expect.any(String)
    )
    expect(git).toHaveBeenCalledWith(
      ['update-ref', '-d', 'refs/heads/feature/test', '1'],
      expect.any(String)
    )
    expect(git).toHaveBeenCalledWith(
      ['config', '--remove-section', 'branch.feature/test'],
      expect.any(String)
    )
    expect(git).toHaveBeenCalledWith(['remote'], expect.any(String))
  })

  it('deletes a squash-merged SSH branch with branch-only merge commits via expected head', async () => {
    const git = vi.fn<GitExec>(async (args, _cwd, opts) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list' && args.includes('-z')) {
        return {
          stdout: worktreeList(
            { path: '/repo', branch: 'main' },
            { path: '/repo-feature', branch: 'feature/test' }
          ),
          stderr: ''
        }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList({ path: '/repo', branch: 'main' }), stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--get') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
        return { stdout: 'target123\n', stderr: '' }
      }
      if (args[0] === 'merge-tree') {
        return {
          stdout: args[2] === 'squash123' ? 'squash-tree\n' : 'merged-tree\n',
          stderr: ''
        }
      }
      if (args[0] === 'rev-parse' && args.includes('target123^{tree}')) {
        return { stdout: 'target-tree\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('squash123^{tree}')) {
        return { stdout: 'squash-tree\n', stderr: '' }
      }
      if (args[0] === 'rev-list' && args.includes('--right-only')) {
        return { stdout: '1\n', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        return { stdout: 'base123\n', stderr: '' }
      }
      if (args[0] === 'diff') {
        return { stdout: 'branch net diff\n', stderr: '' }
      }
      if (args[0] === 'rev-list' && args.includes('--ancestry-path')) {
        return { stdout: 'squash123\n', stderr: '' }
      }
      if (args[0] === 'show') {
        return { stdout: 'squash diff\n', stderr: '' }
      }
      if (args[0] === 'patch-id' && opts?.stdin === 'branch net diff\n') {
        return {
          stdout: 'patch123 0000000000000000000000000000000000000000\n',
          stderr: ''
        }
      }
      if (args[0] === 'patch-id' && opts?.stdin === 'squash diff\n') {
        return { stdout: 'patch123 squash123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })
    ).resolves.toEqual({})

    expect(git).toHaveBeenCalledWith(
      ['update-ref', '-d', 'refs/heads/feature/test', '1'],
      expect.any(String)
    )
    expect(git).toHaveBeenCalledWith(['diff', 'base123', '1'], resolvedRepoPath())
    expect(git).toHaveBeenCalledWith(
      ['merge-tree', '--write-tree', 'squash123', '1'],
      resolvedRepoPath()
    )
    expect(git).toHaveBeenCalledWith(['patch-id', '--stable'], expect.any(String), {
      stdin: 'branch net diff\n'
    })
    expect(git).toHaveBeenCalledWith(['patch-id', '--stable'], expect.any(String), {
      stdin: 'squash diff\n'
    })
  })

  it('refreshes the saved remote base before proving the captured branch head merged', async () => {
    const calls: { args: string[]; cwd: string }[] = []
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push({ args, cwd })
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list' && args.includes('-z')) {
        return {
          stdout: worktreeList(
            { path: '/repo', branch: 'main' },
            { path: '/repo-feature', branch: 'feature/test' }
          ),
          stderr: ''
        }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList({ path: '/repo', branch: 'main' }), stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--get') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
        return { stdout: 'base123\n', stderr: '' }
      }
      if (args[0] === 'merge-tree') {
        return { stdout: 'tree123\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('base123^{tree}')) {
        return { stdout: 'tree123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })
    ).resolves.toEqual({})

    const commandIndex = (expectedArgs: string[]) =>
      calls.findIndex(({ args }) => JSON.stringify(args) === JSON.stringify(expectedArgs))
    const fetchIndex = commandIndex(['fetch', '--prune', 'origin'])
    const mergeTreeArgs = ['merge-tree', '--write-tree', 'base123', '1']
    const mergeTreeIndexes = calls.flatMap(({ args }, index) =>
      JSON.stringify(args) === JSON.stringify(mergeTreeArgs) ? [index] : []
    )
    const updateRefIndex = commandIndex(['update-ref', '-d', 'refs/heads/feature/test', '1'])

    expect(fetchIndex).toBeGreaterThanOrEqual(0)
    expect(calls[fetchIndex]?.cwd).toBe(resolvedRepoPath())
    expect(mergeTreeIndexes).toHaveLength(1)
    expect(fetchIndex).toBeLessThan(mergeTreeIndexes[0])
    expect(mergeTreeIndexes[0]).toBeLessThan(updateRefIndex)
    expect(fetchIndex).toBeLessThan(updateRefIndex)
  })

  it('preserves an already-merged SSH branch when cleanup races after worktree removal', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list' && args.includes('-z')) {
        return {
          stdout: worktreeList(
            { path: '/repo', branch: 'main' },
            { path: '/repo-feature', branch: 'feature/test' }
          ),
          stderr: ''
        }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList({ path: '/repo', branch: 'main' }), stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--get') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
        return { stdout: 'base123\n', stderr: '' }
      }
      if (args[0] === 'rev-list') {
        return { stdout: '0\n', stderr: '' }
      }
      if (args[0] === 'cherry') {
        return { stdout: '- 1 fix: already squash-merged\n', stderr: '' }
      }
      if (args[0] === 'update-ref' && args[1] === '-d') {
        throw new Error('cannot lock ref')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })
    ).resolves.toEqual({
      preservedBranch: { branchName: 'feature/test', head: '1' }
    })

    expect(warnSpy).toHaveBeenCalledWith(
      'relay removeWorktree: preserved local branch "feature/test" after removing worktree',
      expect.objectContaining({ message: 'cannot lock ref' })
    )
    expect(git).toHaveBeenCalledWith(['cherry', '-v', 'base123', '1'], resolvedRepoPath())
    expect(git).toHaveBeenCalledWith(
      ['update-ref', '-d', 'refs/heads/feature/test', '1'],
      resolvedRepoPath()
    )
    expect(git).not.toHaveBeenCalledWith(
      ['config', '--remove-section', 'branch.feature/test'],
      resolvedRepoPath()
    )
    warnSpy.mockRestore()
  })
})
