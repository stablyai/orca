import { describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import type { GitExec } from './git-handler-ops'
import { addWorktreeOp, removeWorktreeOp } from './git-handler-worktree-ops'

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
  return path.resolve('/repo-feature', '/repo/.git', '..')
}

describe('addWorktreeOp', () => {
  it('writes durable branch base config after creating an SSH new-branch worktree', async () => {
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

    await addWorktreeOp(git, {
      repoPath: '/repo',
      branchName: 'feature/test',
      targetDir: '/repo-feature',
      base: 'origin/main'
    })

    expect(git.mock.calls.map((call) => call[0])).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
      [
        'worktree',
        'add',
        '--no-track',
        '-b',
        'feature/test',
        '/repo-feature',
        'refs/remotes/origin/main'
      ],
      [
        'config',
        '--local',
        '--replace-all',
        'branch.feature/test.base',
        'refs/remotes/origin/main'
      ],
      ['config', '--get', 'push.autoSetupRemote']
    ])
    expect(git.mock.calls.map((call) => call[0])).not.toContainEqual([
      'config',
      '--local',
      'branch.feature/test.remote',
      'origin'
    ])
    expect(git.mock.calls.map((call) => call[0])).not.toContainEqual([
      'config',
      '--local',
      'branch.feature/test.merge',
      'refs/heads/main'
    ])
  })

  it('does not write branch base config when checking out an existing SSH branch', async () => {
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

    await addWorktreeOp(git, {
      repoPath: '/repo',
      branchName: 'feature/test',
      targetDir: '/repo-feature',
      base: 'origin/main',
      checkoutExistingBranch: true
    })

    expect(git.mock.calls.map((call) => call[0])).toEqual([
      ['worktree', 'add', '/repo-feature', 'feature/test']
    ])
  })

  it('does not write branch base config when SSH creation has no base', async () => {
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

    await addWorktreeOp(git, {
      repoPath: '/repo',
      branchName: 'feature/no-base',
      targetDir: '/repo-feature'
    })

    expect(git.mock.calls.map((call) => call[0])).toEqual([
      ['worktree', 'add', '--no-track', '-b', 'feature/no-base', '/repo-feature'],
      ['config', '--get', 'push.autoSetupRemote']
    ])
  })

  it('warns and unsets stale branch base config when SSH base persistence fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'config' && args[2] === '--replace-all') {
        throw new Error('config locked')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      addWorktreeOp(git, {
        repoPath: '/repo',
        branchName: 'feature/test',
        targetDir: '/repo-feature',
        base: 'origin/main'
      })
    ).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(
      'relay addWorktree: failed to set branch.feature/test.base for /repo-feature',
      expect.any(Error)
    )
    expect(git.mock.calls.map((call) => call[0])).toContainEqual([
      'config',
      '--local',
      '--unset-all',
      'branch.feature/test.base'
    ])
    warnSpy.mockRestore()
  })
})

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
      `${resolvedRepoPath()}$ worktree list --porcelain -z`,
      `${resolvedRepoPath()}$ worktree remove /repo-feature`,
      `${resolvedRepoPath()}$ branch -d -- feature/test`
    ])
  })

  it('preserves the branch (does not throw) when `branch -d` refuses an unmerged branch', async () => {
    let listCount = 0
    const git = vi.fn<GitExec>(async (args) => {
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
      if (args[0] === 'branch' && args[1] === '-d') {
        throw new Error('error: the branch feature/test is not fully merged')
      }
      return { stdout: '', stderr: '' }
    })

    // The unmerged-branch refusal must be surfaced without failing workspace removal.
    await expect(removeWorktreeOp(git, { worktreePath: '/repo-feature' })).resolves.toEqual({
      preservedBranch: { branchName: 'feature/test', head: '1' }
    })

    expect(git).toHaveBeenCalledWith(['branch', '-d', '--', 'feature/test'], expect.any(String))
    expect(git).not.toHaveBeenCalledWith(['branch', '-D', '--', 'feature/test'], expect.any(String))
  })

  it('force-deletes the just-created branch during failed sparse setup rollback', async () => {
    let listCount = 0
    const git = vi.fn<GitExec>(async (args) => {
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

    await removeWorktreeOp(git, {
      worktreePath: '/repo-feature',
      force: true,
      forceBranchDelete: true
    })

    expect(git).toHaveBeenCalledWith(['branch', '-D', '--', 'feature/test'], expect.any(String))
    expect(git).not.toHaveBeenCalledWith(['branch', '-d', '--', 'feature/test'], expect.any(String))
  })

  it('skips branch deletion entirely when deleteBranch is false', async () => {
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
      `${resolvedRepoPath()}$ worktree list --porcelain -z`,
      `${resolvedRepoPath()}$ worktree remove /repo-feature`
    ])
  })

  it('keeps the branch when Git reports another SSH worktree still uses it', async () => {
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
      if (args[0] === 'branch' && args[1] === '-d') {
        throw new Error(
          "error: cannot delete branch 'feature/test' used by worktree at '/repo-other'"
        )
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeOp(git, { worktreePath: '/repo-feature' })

    expect(git).toHaveBeenCalledWith(['branch', '-d', '--', 'feature/test'], expect.any(String))
    expect(git).toHaveBeenCalledWith(['worktree', 'prune'], expect.any(String))
    expect(git).not.toHaveBeenCalledWith(['branch', '-D', '--', 'feature/test'], expect.any(String))
  })
})
