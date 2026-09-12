import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeProcess from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import type * as WorkspaceSpaceScanBudgetModule from '../shared/workspace-space-scan-budget'
import type { Store } from './persistence'

const { listRepoWorktreesMock } = vi.hoisted(() => ({
  listRepoWorktreesMock: vi.fn()
}))

vi.mock('node:process', async () => {
  const actual = await vi.importActual<typeof NodeProcess>('node:process')
  return { ...actual, platform: 'win32' }
})

vi.mock('../shared/workspace-space-scan-budget', async () => {
  const actual = await vi.importActual<typeof WorkspaceSpaceScanBudgetModule>(
    '../shared/workspace-space-scan-budget'
  )
  return {
    ...actual,
    createWorkspaceSpaceScanBudget: () => actual.createWorkspaceSpaceScanBudget({ maxEntries: 2 })
  }
})

vi.mock('./repo-worktrees', () => ({
  createFolderWorktree: (repo: Repo) => ({
    path: repo.path,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: true
  }),
  listRepoWorktrees: listRepoWorktreesMock
}))

vi.mock('./providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn()
}))

vi.mock('./providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

import { analyzeWorkspaceSpace } from './workspace-space-analysis'

function createStore(repo: Repo): Store {
  return {
    getRepos: () => [repo],
    getWorktreeMeta: () => undefined
  } as unknown as Store
}

describe('analyzeWorkspaceSpace capacity', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    listRepoWorktreesMock.mockReset()
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('fails a worktree closed when the portable scan exceeds its entry budget', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-space-capacity-'))
    const repoPath = join(tempDir, 'repo')
    await mkdir(repoPath, { recursive: true })
    await Promise.all(['one', 'two', 'three'].map((name) => writeFile(join(repoPath, name), name)))
    const repo: Repo = {
      id: 'repo-1',
      path: repoPath,
      displayName: 'orca',
      badgeColor: '#000',
      addedAt: 0
    }
    listRepoWorktreesMock.mockResolvedValue([
      {
        path: repoPath,
        head: 'a',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    const result = await analyzeWorkspaceSpace(createStore(repo))

    expect(result.worktrees[0]).toMatchObject({
      status: 'unavailable',
      sizeBytes: 0,
      error: expect.stringContaining('Workspace is too large to scan safely')
    })
  })
})
