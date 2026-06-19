import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeProcess from 'node:process'
import type { Repo } from '../shared/types'
import type { Store } from './persistence'

const { execFileMock, listRepoWorktreesMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  listRepoWorktreesMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock
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

describe('analyzeWorkspaceSpace local du timeout', () => {
  let tempDir: string | null = null

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-space-du-timeout-'))
    execFileMock.mockReset()
    listRepoWorktreesMock.mockReset()
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('falls back when du never reports completion', async () => {
    const repoPath = join(tempDir!, 'repo')
    await mkdir(repoPath, { recursive: true })
    await writeFile(join(repoPath, 'app.ts'), 'console.log("ok")\n')

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
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }))

    vi.useFakeTimers()
    let settled = false
    const scanPromise = analyzeWorkspaceSpace(createStore([repo])).then((scan) => {
      settled = true
      return scan
    })

    await vi.waitFor(() =>
      expect(execFileMock).toHaveBeenCalledWith(
        'du',
        ['-k', '-d', '1', repoPath],
        expect.any(Object),
        expect.any(Function)
      )
    )
    await vi.advanceTimersByTimeAsync(120_000)

    await vi.waitFor(() => expect(settled).toBe(true))
    await expect(scanPromise).resolves.toMatchObject({
      scannedWorktreeCount: 1,
      unavailableWorktreeCount: 0,
      worktrees: [expect.objectContaining({ status: 'ok', path: repoPath })]
    })
    expect(killMock).toHaveBeenCalled()
  })
})
