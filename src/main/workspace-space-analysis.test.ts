import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import type { Store } from './persistence'

const { listRepoWorktreesMock, getLocalProjectWorktreeGitOptionsMock, workerState } = vi.hoisted(
  () => ({
    listRepoWorktreesMock: vi.fn(),
    getLocalProjectWorktreeGitOptionsMock: vi.fn(),
    workerState: { fail: false }
  })
)

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

vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: getLocalProjectWorktreeGitOptionsMock
}))

vi.mock('./worker-thread-child-process/worker-thread-child-process', () => ({
  spawnProcessOnWorkerThread: () => {
    throw new Error('Use portable traversal in this test')
  }
}))

vi.mock('./workspace-space-scan-worker-client', async () => {
  const { scanLocalWorkspaceSpaceWorktree } = await import('./workspace-space-local-scan')
  return {
    scanLocalWorkspaceSpaceWorktreeViaWorker: (
      ...args: Parameters<typeof scanLocalWorkspaceSpaceWorktree>
    ) => {
      if (workerState.fail) {
        throw new Error('Scan worker unavailable')
      }
      return scanLocalWorkspaceSpaceWorktree(...args)
    }
  }
})

import { analyzeWorkspaceSpace, WorkspaceSpaceScanCancelledError } from './workspace-space-analysis'

function createStore(repos: Repo[], worktreeHostId?: `runtime:${string}`): Store {
  return {
    getRepos: () => repos,
    getWorktreeMeta: (worktreeId: string) => {
      if (worktreeId.endsWith('feature')) {
        return { displayName: 'Feature Workspace', lastActivityAt: 200, hostId: worktreeHostId }
      }
      return worktreeHostId ? { hostId: worktreeHostId } : undefined
    }
  } as Store
}

async function writeSizedFile(filePath: string, size: number): Promise<void> {
  await writeFile(filePath, Buffer.alloc(size, 1))
}

describe('analyzeWorkspaceSpace', () => {
  let tempDir: string | null = null

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-14T12:00:00Z'))
    tempDir = await mkdtemp(join(tmpdir(), 'orca-space-'))
    listRepoWorktreesMock.mockReset()
    getLocalProjectWorktreeGitOptionsMock.mockReset().mockReturnValue({})
    workerState.fail = false
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('scans local worktrees and counts only linked worktrees as reclaimable', async () => {
    const root = tempDir!
    const mainPath = join(root, 'repo')
    const featurePath = join(root, 'feature')
    await mkdir(join(mainPath, 'src'), { recursive: true })
    await mkdir(join(featurePath, 'node_modules'), { recursive: true })
    await mkdir(join(featurePath, 'src'), { recursive: true })
    await writeSizedFile(join(mainPath, 'src', 'main.ts'), 256)
    await writeSizedFile(join(featurePath, 'node_modules', 'pkg.js'), 2048)
    await writeSizedFile(join(featurePath, 'src', 'feature.ts'), 512)

    const repo: Repo = {
      id: 'repo-1',
      path: mainPath,
      displayName: 'orca',
      badgeColor: '#000',
      addedAt: 0
    }
    listRepoWorktreesMock.mockResolvedValue([
      {
        path: mainPath,
        head: 'a',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: featurePath,
        head: 'b',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await analyzeWorkspaceSpace(createStore([repo]))
    const main = result.worktrees.find((row) => row.path === mainPath)
    const feature = result.worktrees.find((row) => row.path === featurePath)

    expect(result.scannedAt).toBe(Date.parse('2026-05-14T12:00:00Z'))
    expect(result.worktreeCount).toBe(2)
    expect(main?.status).toBe('ok')
    expect(main?.canDelete).toBe(false)
    expect(main?.reclaimableBytes).toBe(0)
    expect(feature?.status).toBe('ok')
    expect(feature?.displayName).toBe('Feature Workspace')
    expect(feature?.canDelete).toBe(true)
    expect(feature?.sizeBytes).toBeGreaterThanOrEqual(2048 + 512)
    expect(feature?.reclaimableBytes).toBe(feature?.sizeBytes)
    expect(feature?.topLevelItems[0]?.name).toBe('node_modules')
    expect(result.reclaimableBytes).toBe(feature?.sizeBytes)
  })

  it('omits prunable worktree registrations from the Space scan', async () => {
    const root = tempDir!
    const mainPath = join(root, 'repo')
    const stalePath = join(root, 'stale')
    await mkdir(join(mainPath, 'src'), { recursive: true })
    await writeSizedFile(join(mainPath, 'src', 'main.ts'), 256)

    const repo: Repo = {
      id: 'repo-1',
      path: mainPath,
      displayName: 'orca',
      badgeColor: '#000',
      addedAt: 0
    }
    listRepoWorktreesMock.mockResolvedValue([
      {
        path: mainPath,
        head: 'a',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: stalePath,
        head: 'b',
        branch: 'refs/heads/stale',
        isBare: false,
        prunable: true,
        prunableReason: 'gitdir file points to non-existent location',
        isMainWorktree: false
      }
    ])

    const result = await analyzeWorkspaceSpace(createStore([repo]))

    expect(result.worktreeCount).toBe(1)
    expect(result.worktrees.find((row) => row.path === stalePath)).toBeUndefined()
    expect(result.worktrees.find((row) => row.path === mainPath)?.status).toBe('ok')
    expect(result.repos[0]?.unavailableWorktreeCount).toBe(0)
  })

  it('reports scan progress as repos and worktrees are scanned', async () => {
    const root = tempDir!
    const repoPath = join(root, 'repo')
    await mkdir(repoPath, { recursive: true })
    await writeSizedFile(join(repoPath, 'file.txt'), 128)
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
    const progress: unknown[] = []

    await analyzeWorkspaceSpace(createStore([repo], 'runtime:env-1'), {
      scanId: 'scan-1',
      onProgress: (event) => progress.push(event)
    })

    expect(progress[0]).toMatchObject({
      scanId: 'scan-1',
      totalRepoCount: 1,
      scannedRepoCount: 0,
      totalWorktreeCount: 0,
      scannedWorktreeCount: 0
    })
    expect(progress).toContainEqual(
      expect.objectContaining({
        totalWorktreeCount: 1,
        currentRepoDisplayName: 'orca'
      })
    )
    expect(progress.at(-1)).toMatchObject({
      scannedRepoCount: 1,
      scannedWorktreeCount: 1
    })
    expect(progress).toContainEqual(
      expect.objectContaining({
        completedMeasurements: [
          expect.objectContaining({
            worktreeId: `repo-1::${repoPath}`,
            executionHostId: 'runtime:env-1',
            status: 'ok',
            sizeBytes: expect.any(Number)
          })
        ]
      })
    )
  })

  it('rejects when a scan is cancelled before it starts', async () => {
    const repo: Repo = {
      id: 'repo-1',
      path: tempDir!,
      displayName: 'orca',
      badgeColor: '#000',
      addedAt: 0
    }
    const controller = new AbortController()
    controller.abort()

    await expect(
      analyzeWorkspaceSpace(createStore([repo]), { signal: controller.signal })
    ).rejects.toBeInstanceOf(WorkspaceSpaceScanCancelledError)
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
  })

  it('aborts every in-flight local worktree list when the scan is cancelled', async () => {
    const repos: Repo[] = [
      {
        id: 'repo-1',
        path: join(tempDir!, 'repo-1'),
        displayName: 'one',
        badgeColor: '#000',
        addedAt: 0
      },
      {
        id: 'repo-2',
        path: join(tempDir!, 'repo-2'),
        displayName: 'two',
        badgeColor: '#000',
        addedAt: 0
      }
    ]
    const capturedSignals: AbortSignal[] = []
    let markBothStarted!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve
    })
    listRepoWorktreesMock.mockImplementation((_repo: Repo, options?: { signal?: AbortSignal }) => {
      const signal = options?.signal
      if (!signal) {
        throw new Error('expected cancellation signal')
      }
      capturedSignals.push(signal)
      if (capturedSignals.length === repos.length) {
        markBothStarted()
      }
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const controller = new AbortController()

    const scan = analyzeWorkspaceSpace(createStore(repos), { signal: controller.signal })
    await bothStarted
    controller.abort()

    await expect(scan).rejects.toBeInstanceOf(WorkspaceSpaceScanCancelledError)
    expect(capturedSignals).toHaveLength(2)
    expect(capturedSignals.every((signal) => signal.aborted)).toBe(true)
  })

  it('routes local worktree listing through the selected WSL distro', async () => {
    const repo: Repo = {
      id: 'repo-1',
      path: tempDir!,
      displayName: 'orca',
      badgeColor: '#000',
      addedAt: 0
    }
    getLocalProjectWorktreeGitOptionsMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    listRepoWorktreesMock.mockResolvedValue([])

    await analyzeWorkspaceSpace(createStore([repo]))

    expect(listRepoWorktreesMock).toHaveBeenCalledWith(repo, {
      wslDistro: 'Ubuntu',
      signal: undefined
    })
  })

  it('isolates missing worktrees as row-level scan failures', async () => {
    const root = tempDir!
    const repoPath = join(root, 'repo')
    const missingPath = join(root, 'missing')
    await mkdir(repoPath, { recursive: true })

    const repo: Repo = {
      id: 'repo-1',
      path: repoPath,
      displayName: 'orca',
      badgeColor: '#000',
      addedAt: 0
    }
    listRepoWorktreesMock.mockResolvedValue([
      {
        path: missingPath,
        head: 'b',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await analyzeWorkspaceSpace(createStore([repo]))

    expect(result.worktreeCount).toBe(1)
    expect(result.scannedWorktreeCount).toBe(0)
    expect(result.unavailableWorktreeCount).toBe(1)
    expect(result.worktrees[0]?.status).toBe('missing')
    expect(result.worktrees[0]?.sizeBytes).toBe(0)
  })

  it('reports a failed scan worker without traversing the workspace on the main thread', async () => {
    const repoPath = join(tempDir!, 'repo')
    await mkdir(repoPath)
    await writeSizedFile(join(repoPath, 'file.txt'), 128)
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
    workerState.fail = true

    const result = await analyzeWorkspaceSpace(createStore([repo]))

    expect(result.worktrees[0]).toMatchObject({
      status: 'error',
      sizeBytes: 0,
      error: 'Scan worker unavailable'
    })
  })

  it('reports disconnected SSH repos without failing the whole analysis', async () => {
    const repo: Repo = {
      id: 'repo-remote',
      path: '/remote/repo',
      displayName: 'remote',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-1'
    }

    const result = await analyzeWorkspaceSpace(createStore([repo]))

    expect(result.worktrees).toEqual([])
    expect(result.repos[0]?.error).toContain('not connected')
    expect(result.unavailableWorktreeCount).toBe(1)
  })
})
