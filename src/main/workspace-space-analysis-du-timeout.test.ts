import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeProcess from 'node:process'
import type { Repo } from '../shared/repo-types'
import type { Store } from './persistence'

const { spawnProcessMock, listRepoWorktreesMock } = vi.hoisted(() => ({
  spawnProcessMock: vi.fn(),
  listRepoWorktreesMock: vi.fn()
}))

vi.mock('./worker-thread-child-process/worker-thread-child-process', () => ({
  spawnProcessOnWorkerThread: spawnProcessMock
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

vi.mock('./workspace-space-scan-worker-client', async () => {
  const { scanLocalWorkspaceSpaceWorktree } = await import('./workspace-space-local-scan')
  return { scanLocalWorkspaceSpaceWorktreeViaWorker: scanLocalWorkspaceSpaceWorktree }
})

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
    spawnProcessMock.mockReset()
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
    spawnProcessMock.mockImplementation(() => {
      const child = new EventEmitter()
      return Object.assign(child, { stdout: new EventEmitter(), kill: killMock })
    })

    vi.useFakeTimers()
    let settled = false
    const scanPromise = analyzeWorkspaceSpace(createStore([repo])).then((scan) => {
      settled = true
      return scan
    })

    await vi.waitFor(() =>
      expect(spawnProcessMock).toHaveBeenCalledWith({
        program: 'du',
        args: ['-k', '-d', '1', repoPath]
      })
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

  it('runs one local du traversal at a time across repos', async () => {
    const repoPaths = [join(tempDir!, 'repo-one'), join(tempDir!, 'repo-two')]
    await Promise.all(repoPaths.map((repoPath) => mkdir(repoPath, { recursive: true })))
    const repos: Repo[] = repoPaths.map((repoPath, index) => ({
      id: `repo-${index}`,
      path: repoPath,
      displayName: `repo-${index}`,
      badgeColor: '#000',
      addedAt: 0
    }))
    listRepoWorktreesMock.mockImplementation(async (repo: Repo) => [
      {
        path: repo.path,
        head: 'a',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    const completions: (() => void)[] = []
    let active = 0
    let peak = 0
    spawnProcessMock.mockImplementation((spec: { args: string[] }) => {
      const rootPath = spec.args.at(-1)!
      const child = new EventEmitter()
      const stdout = new EventEmitter()
      active += 1
      peak = Math.max(peak, active)
      completions.push(() => {
        active -= 1
        stdout.emit('data', Buffer.from(`1\t${rootPath}\n`))
        child.emit('close', 0)
      })
      return Object.assign(child, { stdout, kill: vi.fn() })
    })

    const scan = analyzeWorkspaceSpace(createStore(repos))
    await vi.waitFor(() => expect(spawnProcessMock).toHaveBeenCalledTimes(1))
    completions.shift()?.()
    await vi.waitFor(() => expect(spawnProcessMock).toHaveBeenCalledTimes(2))
    completions.shift()?.()

    await expect(scan).resolves.toMatchObject({ scannedWorktreeCount: 2 })
    expect(peak).toBe(1)
  })
})
