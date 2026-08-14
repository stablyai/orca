import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
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

  it('uses linked worktree commit metadata when the .git pointer is stale', async () => {
    const gitDirPath = path.join('/repo', '.git', 'worktrees', 'repo-feature')
    const gitDirHeadPath = path.join(gitDirPath, 'HEAD')
    const commitEditMsgPath = path.join(gitDirPath, 'COMMIT_EDITMSG')
    const origHeadPath = path.join(gitDirPath, 'ORIG_HEAD')
    const statPath = vi.fn(async (targetPath: string) => {
      const mtimes: Record<string, number> = {
        '/repo-feature': 10_000,
        [path.join('/repo-feature', '.git')]: 20_000,
        [gitDirHeadPath]: 60_000,
        [origHeadPath]: 65_000,
        [commitEditMsgPath]: 70_000
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
    expect(statPath).toHaveBeenCalledWith(gitDirHeadPath)
    expect(statPath).toHaveBeenCalledWith(commitEditMsgPath)
    expect(statPath).toHaveBeenCalledWith(origHeadPath)
    expect(worktree.lastActivityAt).toBe(70_000)
  })

  it('ignores gitdir metadata that git maintenance and git status restamp', async () => {
    const gitDirPath = path.join('/repo', '.git', 'worktrees', 'repo-feature')
    const statPath = vi.fn(async (targetPath: string) => {
      const mtimes: Record<string, number> = {
        '/repo-feature': 10_000,
        [path.join('/repo-feature', '.git')]: 10_000,
        [gitDirPath]: 90_000,
        [path.join(gitDirPath, 'index')]: 90_000,
        [path.join(gitDirPath, 'logs', 'HEAD')]: 90_000
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

    expect(statPath).not.toHaveBeenCalledWith(gitDirPath)
    expect(statPath).not.toHaveBeenCalledWith(path.join(gitDirPath, 'index'))
    expect(statPath).not.toHaveBeenCalledWith(path.join(gitDirPath, 'logs', 'HEAD'))
    expect(worktree.lastActivityAt).toBe(10_000)
  })

  it('reads the newest reflog entry timestamp instead of the reflog file mtime', async () => {
    const gitDirPath = path.join('/repo', '.git', 'worktrees', 'repo-feature')
    const reflogPath = path.join(gitDirPath, 'logs', 'HEAD')
    const statPath = vi.fn(async () => ({ mtimeMs: 10_000 }))
    const readTextFile = vi.fn(async (targetPath: string) =>
      targetPath === reflogPath
        ? [
            '0000 1111 Dev <dev@example.com> 1700000000 -0700\tbranch: Created from HEAD',
            '1111 2222 Dev <dev@example.com> 1700000900 -0700\tcommit: work',
            ''
          ].join('\n')
        : `gitdir: ${gitDirPath}\n`
    )

    const worktree = await resolveWorkspaceCleanupActivityWorktree(
      REPO,
      makeWorktree(),
      statPath,
      readTextFile
    )

    // Why: only the tail of the reflog is read — the newest entry is enough.
    expect(readTextFile).toHaveBeenCalledWith(reflogPath, { tailBytes: 8192 })
    expect(worktree.lastActivityAt).toBe(1_700_000_900_000)
  })

  it('falls back to a full reflog read when the newest entry exceeds the tail window', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cleanup-activity-'))
    try {
      const gitDir = path.join(dir, 'gitdir')
      await mkdir(path.join(gitDir, 'logs'), { recursive: true })
      const worktreePath = path.join(dir, 'wt')
      await mkdir(worktreePath, { recursive: true })
      await writeFile(path.join(worktreePath, '.git'), `gitdir: ${gitDir}\n`)
      // Why: a single record longer than the 8192-byte tail window keeps its
      // timestamp before the window; the reader must fall back to a full read.
      await writeFile(
        path.join(gitDir, 'logs', 'HEAD'),
        '0000 1111 Dev <dev@example.com> 1700000000 -0700\tbranch: Created from HEAD\n' +
          `1111 2222 Dev <dev@example.com> 1700000900 -0700\tcommit: ${'x'.repeat(9000)}\n`
      )
      const statPath = vi.fn(async () => ({ mtimeMs: 10_000 }))

      const worktree = await resolveWorkspaceCleanupActivityWorktree(
        REPO,
        makeWorktree({ path: worktreePath }),
        statPath
      )

      expect(worktree.lastActivityAt).toBe(1_700_000_900_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('degrades to other probes when the reflog was expired to an empty file', async () => {
    const gitDirPath = path.join('/repo', '.git', 'worktrees', 'repo-feature')
    const statPath = vi.fn(async () => ({ mtimeMs: 10_000 }))
    const readTextFile = vi.fn(async (targetPath: string) =>
      targetPath === path.join(gitDirPath, 'logs', 'HEAD') ? '' : `gitdir: ${gitDirPath}\n`
    )

    const worktree = await resolveWorkspaceCleanupActivityWorktree(
      REPO,
      makeWorktree(),
      statPath,
      readTextFile
    )

    expect(worktree.lastActivityAt).toBe(10_000)
  })

  it('resolves relative linked worktree gitdir pointers from the worktree path', async () => {
    const gitDirPath = path.resolve('/repo-feature', '.repo/gitdir')
    const commitEditMsgPath = path.join(gitDirPath, 'COMMIT_EDITMSG')
    const statPath = vi.fn(async (targetPath: string) => ({
      mtimeMs: targetPath === commitEditMsgPath ? 40_000 : 10_000
    }))
    const readTextFile = vi.fn(async () => 'gitdir: .repo/gitdir\n')

    const worktree = await resolveWorkspaceCleanupActivityWorktree(
      REPO,
      makeWorktree(),
      statPath,
      readTextFile
    )

    expect(statPath).toHaveBeenCalledWith(commitEditMsgPath)
    expect(worktree.lastActivityAt).toBe(40_000)
  })

  it('converts WSL linked worktree gitdir pointers before reading metadata', async () => {
    const worktreePath = String.raw`\\wsl.localhost\Ubuntu\home\me\repo-feature`
    const gitDirPath = String.raw`\\wsl.localhost\Ubuntu\home\me\repo\.git\worktrees\repo-feature`
    const gitDirHeadPath = path.join(gitDirPath, 'HEAD')
    const commitEditMsgPath = path.join(gitDirPath, 'COMMIT_EDITMSG')
    const statPath = vi.fn(async (targetPath: string) => {
      const mtimes: Record<string, number> = {
        [worktreePath]: 10_000,
        [path.join(worktreePath, '.git')]: 20_000,
        [gitDirHeadPath]: 60_000,
        [commitEditMsgPath]: 70_000
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
    expect(statPath).toHaveBeenCalledWith(gitDirHeadPath)
    expect(statPath).toHaveBeenCalledWith(commitEditMsgPath)
    expect(statPath).not.toHaveBeenCalledWith(
      path.join('/home/me/repo/.git/worktrees/repo-feature', 'HEAD')
    )
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
