import { describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import { GitCapabilityCache } from '../shared/git-capability-cache'
import type { GitExec } from './git-handler-ops'
import { removeWorktreeOp } from './git-handler-worktree-ops'

function removeWorktreeWithCapabilityCache(
  git: GitExec,
  params: Parameters<typeof removeWorktreeOp>[1]
) {
  return removeWorktreeOp(git, params, new GitCapabilityCache())
}

function lineWorktreeList(...entries: { path: string; branch?: string }[]): string {
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

function nulWorktreeList(...entries: { path: string; branch?: string }[]): string {
  return entries
    .map((entry, index) =>
      [
        `worktree ${entry.path}`,
        `HEAD ${index}`,
        ...(entry.branch ? [`branch refs/heads/${entry.branch}`] : []),
        ''
      ].join('\0')
    )
    .join('\0')
}

function resolvedRepoPath(): string {
  return path.posix.resolve('/repo-feature', '/repo/.git', '..')
}

describe('relay worktree path parsing', () => {
  it('deletes the matching branch for SSH worktrees whose paths contain newlines', async () => {
    const worktreePath = '/repo-feature\nremote'
    let listCount = 0
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args.join(' ') === 'rev-parse --verify --quiet HEAD^{commit}') {
        return { stdout: 'base123\n', stderr: '' }
      }
      if (args.join(' ') === 'merge-base base123 1') {
        return { stdout: '1\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCount += 1
        return {
          stdout:
            listCount === 1
              ? nulWorktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: worktreePath, branch: 'feature/newline' }
                )
              : lineWorktreeList({ path: '/repo', branch: 'main' }),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeWithCapabilityCache(git, { worktreePath })

    expect(git).toHaveBeenCalledWith(['worktree', 'remove', worktreePath], resolvedRepoPath())
    expect(git).toHaveBeenCalledWith(['merge-base', 'base123', '1'], resolvedRepoPath())
    expect(git).toHaveBeenCalledWith(
      ['update-ref', '-d', 'refs/heads/feature/newline', '1'],
      resolvedRepoPath()
    )
    expect(git).not.toHaveBeenCalledWith(
      ['branch', '-d', '--', 'feature/newline'],
      expect.any(String)
    )
  })

  it('falls back to line-block worktree listing when remote Git rejects -z', async () => {
    const calls: string[] = []
    let listCount = 0
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push(`${cwd}$ ${args.join(' ')}`)
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args.join(' ') === 'rev-parse --verify --quiet HEAD^{commit}') {
        return { stdout: 'base123\n', stderr: '' }
      }
      if (args.join(' ') === 'merge-base base123 1') {
        return { stdout: '1\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list' && args.includes('-z')) {
        throw Object.assign(new Error("unknown switch `z'"), {
          stderr: "error: unknown switch `z'"
        })
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCount += 1
        return {
          stdout:
            listCount === 1
              ? lineWorktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-feature', branch: 'feature/test' }
                )
              : lineWorktreeList({ path: '/repo', branch: 'main' }),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })

    expect(calls).toEqual([
      '/repo-feature$ rev-parse --git-common-dir',
      `${resolvedRepoPath()}$ worktree list --porcelain -z`,
      `${resolvedRepoPath()}$ worktree list --porcelain`,
      `${resolvedRepoPath()}$ worktree remove /repo-feature`,
      `${resolvedRepoPath()}$ config --get branch.feature/test.base`,
      `${resolvedRepoPath()}$ symbolic-ref --quiet refs/remotes/origin/HEAD`,
      `${resolvedRepoPath()}$ rev-parse --verify --quiet HEAD^{commit}`,
      `${resolvedRepoPath()}$ merge-base base123 1`,
      `${resolvedRepoPath()}$ worktree list --porcelain`,
      `${resolvedRepoPath()}$ update-ref -d refs/heads/feature/test 1`,
      `${resolvedRepoPath()}$ worktree list --porcelain`,
      `${resolvedRepoPath()}$ config --remove-section branch.feature/test`
    ])
  })
})
