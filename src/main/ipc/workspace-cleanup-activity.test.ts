import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../shared/types'
import { resolveWorkspaceCleanupActivityWorktree } from './workspace-cleanup-activity'

const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 1
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo-feature',
    repoId: 'repo-1',
    path: '/repo-feature',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedLinearIssueWorkspaceId: null,
    linkedLinearIssueOrganizationUrlKey: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    workspaceStatus: 'in-progress',
    ...overrides
  }
}

describe('resolveWorkspaceCleanupActivityWorktree', () => {
  it('uses local worktree filesystem metadata when persisted activity is missing', async () => {
    const statPath = vi.fn(async (targetPath: string) => ({
      mtimeMs: targetPath.endsWith('.git') ? 20_000 : 10_000
    }))

    const worktree = await resolveWorkspaceCleanupActivityWorktree(REPO, makeWorktree(), statPath)

    expect(statPath).toHaveBeenCalledWith('/repo-feature')
    expect(statPath).toHaveBeenCalledWith(path.join('/repo-feature', '.git'))
    expect(worktree.lastActivityAt).toBe(20_000)
  })

  it('uses linked worktree gitdir metadata when the .git pointer is stale', async () => {
    const gitDirPath = path.join('/repo', '.git', 'worktrees', 'repo-feature')
    const gitDirHeadPath = path.join(gitDirPath, 'HEAD')
    const gitDirLogsHeadPath = path.join(gitDirPath, 'logs', 'HEAD')
    const statPath = vi.fn(async (targetPath: string) => {
      const mtimes: Record<string, number> = {
        '/repo-feature': 10_000,
        [path.join('/repo-feature', '.git')]: 20_000,
        [gitDirPath]: 50_000,
        [gitDirHeadPath]: 60_000,
        [gitDirLogsHeadPath]: 70_000
      }
      return { mtimeMs: mtimes[targetPath] ?? 0 }
    })
    const readTextFile = vi.fn(async () => `gitdir: ${gitDirPath}\n`)

    const worktree = await resolveWorkspaceCleanupActivityWorktree(
      REPO,
      makeWorktree(),
      statPath,
      readTextFile
    )

    expect(readTextFile).toHaveBeenCalledWith(path.join('/repo-feature', '.git'))
    expect(statPath).toHaveBeenCalledWith(gitDirPath)
    expect(statPath).toHaveBeenCalledWith(gitDirHeadPath)
    expect(statPath).toHaveBeenCalledWith(gitDirLogsHeadPath)
    expect(worktree.lastActivityAt).toBe(70_000)
  })

  it('resolves relative linked worktree gitdir pointers from the worktree path', async () => {
    const gitDirPath = path.resolve('/repo-feature', '.repo/gitdir')
    const gitDirLogsHeadPath = path.join(gitDirPath, 'logs', 'HEAD')
    const statPath = vi.fn(async (targetPath: string) => ({
      mtimeMs: targetPath === gitDirLogsHeadPath ? 40_000 : 10_000
    }))
    const readTextFile = vi.fn(async () => 'gitdir: .repo/gitdir\n')

    const worktree = await resolveWorkspaceCleanupActivityWorktree(
      REPO,
      makeWorktree(),
      statPath,
      readTextFile
    )

    expect(statPath).toHaveBeenCalledWith(gitDirLogsHeadPath)
    expect(worktree.lastActivityAt).toBe(40_000)
  })

  it('converts WSL linked worktree gitdir pointers before reading metadata', async () => {
    const worktreePath = String.raw`\\wsl.localhost\Ubuntu\home\me\repo-feature`
    const gitDirPath = String.raw`\\wsl.localhost\Ubuntu\home\me\repo\.git\worktrees\repo-feature`
    const gitDirHeadPath = path.join(gitDirPath, 'HEAD')
    const gitDirLogsHeadPath = path.join(gitDirPath, 'logs', 'HEAD')
    const statPath = vi.fn(async (targetPath: string) => {
      const mtimes: Record<string, number> = {
        [worktreePath]: 10_000,
        [path.join(worktreePath, '.git')]: 20_000,
        [gitDirPath]: 50_000,
        [gitDirHeadPath]: 60_000,
        [gitDirLogsHeadPath]: 70_000
      }
      return { mtimeMs: mtimes[targetPath] ?? 0 }
    })
    const readTextFile = vi.fn(async () => 'gitdir: /home/me/repo/.git/worktrees/repo-feature\n')

    const worktree = await resolveWorkspaceCleanupActivityWorktree(
      REPO,
      makeWorktree({ path: worktreePath }),
      statPath,
      readTextFile
    )

    expect(readTextFile).toHaveBeenCalledWith(path.join(worktreePath, '.git'))
    expect(statPath).toHaveBeenCalledWith(gitDirPath)
    expect(statPath).toHaveBeenCalledWith(gitDirHeadPath)
    expect(statPath).toHaveBeenCalledWith(gitDirLogsHeadPath)
    expect(statPath).not.toHaveBeenCalledWith('/home/me/repo/.git/worktrees/repo-feature')
    expect(worktree.lastActivityAt).toBe(70_000)
  })

  it('keeps persisted activity when it is newer than local metadata', async () => {
    const statPath = vi.fn(async () => ({ mtimeMs: 10_000 }))

    const worktree = await resolveWorkspaceCleanupActivityWorktree(
      REPO,
      makeWorktree({ lastActivityAt: 30_000 }),
      statPath
    )

    expect(worktree.lastActivityAt).toBe(30_000)
  })

  it('does not stat remote worktree paths', async () => {
    const statPath = vi.fn(async () => ({ mtimeMs: 20_000 }))

    const worktree = await resolveWorkspaceCleanupActivityWorktree(
      { ...REPO, connectionId: 'ssh-1' },
      makeWorktree({ createdAt: 10_000 }),
      statPath
    )

    expect(statPath).not.toHaveBeenCalled()
    expect(worktree.lastActivityAt).toBe(10_000)
  })
})
