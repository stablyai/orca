import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeProcess from 'node:process'
import type { Repo } from '../shared/types'
import type { Store } from './persistence'

const { lstatMock, opendirMock, spawnMock, listRepoWorktreesMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  opendirMock: vi.fn(),
  spawnMock: vi.fn(),
  listRepoWorktreesMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  opendir: opendirMock
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

vi.mock('node:process', async () => {
  const actual = await vi.importActual<typeof NodeProcess>('node:process')
  return { ...actual, platform: 'darwin' }
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

function createStore(repos: Repo[]): Store {
  return {
    getRepos: () => repos,
    getWorktreeMeta: () => undefined
  } as unknown as Store
}

function createDirStat(size = 16) {
  return {
    size,
    isSymbolicLink: () => false,
    isDirectory: () => true
  }
}

function createFileStat(size: number) {
  return {
    size,
    isSymbolicLink: () => false,
    isDirectory: () => false
  }
}

describe('analyzeWorkspaceSpace fallback concurrency', () => {
  beforeEach(() => {
    lstatMock.mockReset()
    opendirMock.mockReset()
    spawnMock.mockReset()
    listRepoWorktreesMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('scans portable fallback entries concurrently without retaining a child tree', async () => {
    const repoPath = '/repo'
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
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error('du not found'), { code: 'ENOENT' })
    })
    opendirMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { name: 'a.txt' }
        yield { name: 'b.txt' }
      }
    })

    let started = 0
    let active = 0
    let maxActive = 0
    let released = false
    const releases: (() => void)[] = []
    const releaseAll = (): void => {
      released = true
      while (releases.length > 0) {
        releases.shift()?.()
      }
    }
    lstatMock.mockImplementation((targetPath: string) => {
      if (targetPath === repoPath) {
        return Promise.resolve(createDirStat())
      }
      started += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      const finish = (): ReturnType<typeof createFileStat> => {
        active -= 1
        return createFileStat(targetPath.endsWith('a.txt') ? 128 : 256)
      }
      if (released) {
        return Promise.resolve(finish())
      }
      return new Promise((resolve) => {
        releases.push(() => resolve(finish()))
      })
    })

    const scanPromise = analyzeWorkspaceSpace(createStore([repo]))
    try {
      await vi.waitFor(() => expect(started).toBeGreaterThanOrEqual(2), { timeout: 200 })
    } finally {
      releaseAll()
    }

    await expect(scanPromise).resolves.toMatchObject({
      worktrees: [
        expect.objectContaining({
          status: 'ok',
          topLevelItems: expect.arrayContaining([
            expect.objectContaining({ name: 'a.txt', sizeBytes: 128 }),
            expect.objectContaining({ name: 'b.txt', sizeBytes: 256 })
          ])
        })
      ]
    })
    expect(maxActive).toBeGreaterThan(1)
  })
})
