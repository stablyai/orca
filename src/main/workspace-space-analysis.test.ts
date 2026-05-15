/* eslint-disable max-lines -- Why: scan, cancellation, SSH fallback, and compaction tests share temp-repo fixtures. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/types'
import type { Store } from './persistence'

const { listRepoWorktreesMock, getSshFilesystemProviderMock, getSshGitProviderMock } = vi.hoisted(
  () => ({
    listRepoWorktreesMock: vi.fn(),
    getSshFilesystemProviderMock: vi.fn(),
    getSshGitProviderMock: vi.fn()
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

vi.mock('./providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))

vi.mock('./providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

import { analyzeWorkspaceSpace, WorkspaceSpaceScanCancelledError } from './workspace-space-analysis'

function createStore(repos: Repo[]): Store {
  return {
    getRepos: () => repos,
    getWorktreeMeta: (worktreeId: string) => {
      if (worktreeId.endsWith('feature')) {
        return { displayName: 'Feature Workspace', lastActivityAt: 200 }
      }
      return undefined
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
    getSshFilesystemProviderMock.mockReset()
    getSshGitProviderMock.mockReset()
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

    await analyzeWorkspaceSpace(createStore([repo]), {
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

  it('scans SSH worktrees through the remote filesystem provider without following symlinks', async () => {
    const repo: Repo = {
      id: 'repo-remote',
      path: '/remote/repo',
      displayName: 'remote',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-1'
    }
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/feature',
          head: 'c',
          branch: 'refs/heads/feature',
          isBare: false,
          isMainWorktree: false
        }
      ])
    })

    const statByPath = new Map([
      ['/remote/feature', { size: 10, type: 'directory' as const, mtime: 0 }],
      ['/remote/feature/node_modules', { size: 5, type: 'directory' as const, mtime: 0 }],
      ['/remote/feature/node_modules/pkg.js', { size: 1000, type: 'file' as const, mtime: 0 }],
      ['/remote/feature/file.log', { size: 200, type: 'file' as const, mtime: 0 }]
    ])
    const readDirMock = vi.fn(async (dirPath: string) => {
      if (dirPath === '/remote/feature') {
        return [
          { name: 'node_modules', isDirectory: true, isSymlink: false },
          { name: 'linked-cache', isDirectory: true, isSymlink: true },
          { name: 'file.log', isDirectory: false, isSymlink: false }
        ]
      }
      if (dirPath === '/remote/feature/node_modules') {
        return [{ name: 'pkg.js', isDirectory: false, isSymlink: false }]
      }
      return []
    })
    const statMock = vi.fn(async (filePath: string) => {
      const stat = statByPath.get(filePath)
      if (!stat) {
        throw Object.assign(new Error(`missing ${filePath}`), { code: 'ENOENT' })
      }
      return stat
    })
    getSshFilesystemProviderMock.mockReturnValue({
      readDir: readDirMock,
      stat: statMock
    })

    const result = await analyzeWorkspaceSpace(createStore([repo]))

    expect(result.worktrees[0]?.status).toBe('ok')
    expect(result.worktrees[0]?.sizeBytes).toBe(1215)
    expect(result.worktrees[0]?.topLevelItems.map((item) => item.name)).toEqual([
      'node_modules',
      'file.log',
      'linked-cache'
    ])
    expect(statMock).not.toHaveBeenCalledWith('/remote/feature/linked-cache')
  })

  it('uses the SSH bulk Space scan provider when available', async () => {
    const repo: Repo = {
      id: 'repo-remote',
      path: '/remote/repo',
      displayName: 'remote',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-1'
    }
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/feature',
          head: 'c',
          branch: 'refs/heads/feature',
          isBare: false,
          isMainWorktree: false
        }
      ])
    })
    const scanWorkspaceSpace = vi.fn().mockResolvedValue({
      sizeBytes: 4096,
      skippedEntryCount: 0,
      topLevelItems: [
        {
          name: 'node_modules',
          path: '/remote/feature/node_modules',
          kind: 'directory',
          sizeBytes: 4096
        }
      ],
      omittedTopLevelItemCount: 0,
      omittedTopLevelSizeBytes: 0
    })
    const readDir = vi.fn()
    const stat = vi.fn()
    getSshFilesystemProviderMock.mockReturnValue({ scanWorkspaceSpace, readDir, stat })

    const result = await analyzeWorkspaceSpace(createStore([repo]))

    expect(scanWorkspaceSpace).toHaveBeenCalledWith(
      '/remote/feature',
      expect.objectContaining({ signal: undefined })
    )
    expect(readDir).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(result.worktrees[0]?.sizeBytes).toBe(4096)
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
    getSshGitProviderMock.mockReturnValue(undefined)

    const result = await analyzeWorkspaceSpace(createStore([repo]))

    expect(result.worktrees).toEqual([])
    expect(result.repos[0]?.error).toContain('not connected')
    expect(result.unavailableWorktreeCount).toBe(1)
  })
})
