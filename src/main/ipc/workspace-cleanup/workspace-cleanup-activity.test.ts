import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { resolveWorkspaceCleanupActivityWorktree } from './workspace-cleanup-activity'
import type { WorkspaceCleanupGitRoute } from './workspace-cleanup-git-route'

const LOCAL_ROUTE: WorkspaceCleanupGitRoute = { kind: 'local', hostId: 'local' }

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
  it('falls back to a full reflog read when the newest entry exceeds the tail window', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cleanup-activity-'))
    try {
      const gitDir = path.join(dir, 'gitdir')
      await mkdir(path.join(gitDir, 'logs'), { recursive: true })
      const worktreePath = path.join(dir, 'wt')
      await mkdir(worktreePath, { recursive: true })
      await writeFile(path.join(worktreePath, '.git'), `gitdir: ${gitDir}\n`)
      // A reflog entry longer than the tail window needs a full read to find its timestamp.
      await writeFile(
        path.join(gitDir, 'logs', 'HEAD'),
        '0000 1111 Dev <dev@example.com> 1700000000 -0700\tbranch: Created from HEAD\n' +
          `1111 2222 Dev <dev@example.com> 1700000900 -0700\tcommit: ${'x'.repeat(9000)}\n`
      )
      const statPath = vi.fn(async () => ({ mtimeMs: 10_000 }))

      const worktree = await resolveWorkspaceCleanupActivityWorktree(
        LOCAL_ROUTE,
        makeWorktree({ path: worktreePath }),
        statPath
      )

      expect(worktree.lastActivityAt).toBe(1_700_000_900_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
