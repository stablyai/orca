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

function resolvedRepoPath(): string {
  return '/repo'
}

describe('removeWorktreeOp branch cleanup', () => {
  it('deletes a squash-merged SSH branch when merging it into the base is a no-op', async () => {
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
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList({ path: '/repo', branch: 'main' }), stderr: '' }
      }
      if (args[0] === 'branch' && args[1] === '-d') {
        throw new Error('error: the branch feature/test is not fully merged')
      }
      if (args[0] === 'config' && args[1] === '--get') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
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

    await expect(removeWorktreeOp(git, { worktreePath: '/repo-feature' })).resolves.toEqual({})

    expect(git).toHaveBeenCalledWith(['branch', '-d', '--', 'feature/test'], expect.any(String))
    expect(git).toHaveBeenCalledWith(
      ['merge-tree', '--write-tree', 'base123', 'refs/heads/feature/test'],
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
  })

  it('refreshes the saved remote base before deleting a safe-delete-rejected SSH branch', async () => {
    const calls: { args: string[]; cwd: string }[] = []
    let zListCount = 0
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push({ args, cwd })
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
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList({ path: '/repo', branch: 'main' }), stderr: '' }
      }
      if (args[0] === 'branch' && args[1] === '-d') {
        throw new Error('error: the branch feature/test is not fully merged')
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

    await expect(removeWorktreeOp(git, { worktreePath: '/repo-feature' })).resolves.toEqual({})

    const commandIndex = (expectedArgs: string[]) =>
      calls.findIndex(({ args }) => JSON.stringify(args) === JSON.stringify(expectedArgs))
    const fetchIndex = commandIndex(['fetch', '--prune', 'origin'])
    const mergeTreeIndex = commandIndex([
      'merge-tree',
      '--write-tree',
      'base123',
      'refs/heads/feature/test'
    ])
    const updateRefIndex = commandIndex(['update-ref', '-d', 'refs/heads/feature/test', '1'])

    expect(fetchIndex).toBeGreaterThanOrEqual(0)
    expect(calls[fetchIndex]?.cwd).toBe(resolvedRepoPath())
    expect(fetchIndex).toBeLessThan(mergeTreeIndex)
    expect(fetchIndex).toBeLessThan(updateRefIndex)
  })

  it('preserves an already-merged SSH branch when cleanup races after worktree removal', async () => {
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
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: worktreeList({ path: '/repo', branch: 'main' }), stderr: '' }
      }
      if (args[0] === 'branch' && args[1] === '-d') {
        throw new Error('error: the branch feature/test is not fully merged')
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

    await expect(removeWorktreeOp(git, { worktreePath: '/repo-feature' })).resolves.toEqual({
      preservedBranch: { branchName: 'feature/test', head: '1' }
    })

    expect(warnSpy).toHaveBeenCalledWith(
      'relay removeWorktree: failed to delete already-merged local branch "feature/test" after removing worktree',
      expect.any(Error)
    )
    expect(warnSpy).toHaveBeenCalledWith(
      'relay removeWorktree: preserved local branch "feature/test" after removing worktree (not fully merged)',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })
})
