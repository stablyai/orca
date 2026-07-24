import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeProcess from 'node:process'
import type { Repo } from '../shared/types'
import { WORKSPACE_SPACE_MAX_SCANNED_ENTRIES } from '../shared/workspace-space-scan-budget'
import type { Store } from './persistence'

const { lstatMock, opendirMock, listRepoWorktreesMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  opendirMock: vi.fn(),
  listRepoWorktreesMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  opendir: opendirMock
}))

vi.mock('node:process', async () => {
  const actual = await vi.importActual<typeof NodeProcess>('node:process')
  return { ...actual, platform: 'win32' }
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

describe('analyzeWorkspaceSpace portable scan capacity', () => {
  beforeEach(() => {
    lstatMock.mockReset()
    opendirMock.mockReset()
    listRepoWorktreesMock.mockReset()
  })

  it('surfaces an over-cap Windows directory as an unavailable row', async () => {
    const repo: Repo = {
      id: 'repo-1',
      path: 'C:\\repo',
      displayName: 'orca',
      badgeColor: '#000',
      addedAt: 0
    }
    listRepoWorktreesMock.mockResolvedValue([
      {
        path: repo.path,
        head: 'a',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    lstatMock.mockResolvedValue({
      size: 1,
      isDirectory: () => true,
      isSymbolicLink: () => false
    })
    opendirMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        const entry = { name: 'repeated-entry' }
        for (let index = 0; index <= WORKSPACE_SPACE_MAX_SCANNED_ENTRIES; index += 1) {
          yield entry
        }
      }
    })

    const result = await analyzeWorkspaceSpace(createStore(repo))

    expect(result).toMatchObject({
      scannedWorktreeCount: 0,
      unavailableWorktreeCount: 1,
      worktrees: [
        {
          status: 'error',
          error: expect.stringContaining('too large to scan safely'),
          sizeBytes: 0
        }
      ]
    })
    expect(lstatMock).toHaveBeenCalledTimes(1)
  })
})
