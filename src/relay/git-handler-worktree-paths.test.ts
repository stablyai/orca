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
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
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
              : nulWorktreeList({ path: '/repo', branch: 'main' }),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeWithCapabilityCache(git, { worktreePath })

    expect(git).toHaveBeenCalledWith(['branch', '-d', '--', 'feature/newline'], resolvedRepoPath())
  })

  it('falls back to line-block worktree listing when remote Git rejects -z', async () => {
    const calls: string[] = []
    let listCount = 0
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push(`${cwd}$ ${args.join(' ')}`)
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
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
      `${resolvedRepoPath()}$ branch -d -- feature/test`
    ])
  })
})
