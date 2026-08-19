import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'

const { reposMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return { reposMocks: moduleMocks.createReposIpcMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>())
)
vi.mock('../git/runner', async (importOriginal) =>
  moduleMocks.gitRunnerModuleMock(reposMocks, await importOriginal<typeof GitRunner>())
)
vi.mock('../git/worktree', () => moduleMocks.gitWorktreeModuleMock(reposMocks))
vi.mock('./registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(reposMocks))
vi.mock('../providers/ssh-filesystem-dispatch', () =>
  moduleMocks.sshFilesystemDispatchModuleMock(reposMocks)
)
vi.mock('./ssh', () => moduleMocks.sshModuleMock(reposMocks))

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { getGitRepoRoot, isGitRepo } from '../git/repo'
import { createRepoHandlerHarness, resetProjectGroupMocks } from './repos-remote-test-harness'

const { handleMock, mockStore, mockGitProvider, mockFilesystemProvider } = reposMocks

beforeEach(() => {
  clearGitCapabilityStateForTests()
  resetSshProviderAuthorities()
})

describe('projectGroups IPC validation', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()

  beforeEach(() => {
    captureHandlers(handleMock)
    mockWindow.webContents.send.mockReset()
    resetProjectGroupMocks(reposMocks, { isGitRepo, getGitRepoRoot })

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('scans nested repositories over a connected SSH filesystem', async () => {
    mockGitProvider.isGitRepoAsync.mockImplementation(async (path: string) => ({
      isRepo: path === '/srv/platform/api',
      rootPath: null
    }))
    mockFilesystemProvider.stat.mockImplementation(async (path: string) => {
      if (path === '/srv/platform/api/.git') {
        return { type: 'directory', size: 0, mtime: 0 }
      }
      throw new Error('not found')
    })
    mockFilesystemProvider.readDir.mockImplementation(async (dirPath: string) =>
      dirPath === '/srv/platform' ? [{ name: 'api', isDirectory: true, isSymlink: false }] : []
    )

    const result = await handlers.get('projectGroups:scanNested')!(null, {
      path: '/srv/platform',
      connectionId: 'conn-1'
    })

    expect(result).toMatchObject({
      selectedPath: '/srv/platform',
      selectedPathKind: 'non_git_folder',
      repos: [{ path: '/srv/platform/api', displayName: 'api' }]
    })
  })

  it('detects nested bare repositories over a connected SSH filesystem', async () => {
    mockGitProvider.isGitRepoAsync.mockResolvedValue({ isRepo: false, rootPath: null })
    mockFilesystemProvider.stat.mockImplementation(async (path: string) => {
      if (path === '/srv/platform/mirror.git/HEAD') {
        return { type: 'file', size: 0, mtime: 0 }
      }
      if (path === '/srv/platform/mirror.git/objects' || path === '/srv/platform/mirror.git/refs') {
        return { type: 'directory', size: 0, mtime: 0 }
      }
      throw new Error('not found')
    })
    mockFilesystemProvider.readDir.mockImplementation(async (dirPath: string) =>
      dirPath === '/srv/platform'
        ? [{ name: 'mirror.git', isDirectory: true, isSymlink: false }]
        : []
    )

    const result = await handlers.get('projectGroups:scanNested')!(null, {
      path: '/srv/platform',
      connectionId: 'conn-1'
    })

    expect(result).toMatchObject({
      selectedPath: '/srv/platform',
      selectedPathKind: 'non_git_folder',
      repos: [{ path: '/srv/platform/mirror.git', displayName: 'mirror.git' }]
    })
  })

  it('skips symlinked directories during SSH nested repository scans', async () => {
    mockGitProvider.isGitRepoAsync.mockResolvedValue({ isRepo: false, rootPath: null })
    mockFilesystemProvider.stat.mockImplementation(async (path: string) => {
      if (path === '/srv/platform/api/.git' || path === '/srv/platform/linked-outside/.git') {
        return { type: 'directory', size: 0, mtime: 0 }
      }
      throw new Error('not found')
    })
    mockFilesystemProvider.readDir.mockImplementation(async (dirPath: string) =>
      dirPath === '/srv/platform'
        ? [
            { name: 'linked-outside', isDirectory: true, isSymlink: true },
            { name: 'api', isDirectory: true, isSymlink: false }
          ]
        : []
    )

    const result = await handlers.get('projectGroups:scanNested')!(null, {
      path: '/srv/platform',
      connectionId: 'conn-1'
    })

    expect((result as { repos: { path: string }[] }).repos.map((repo) => repo.path)).toEqual([
      '/srv/platform/api'
    ])
  })

  it('prioritizes shallow sibling repositories before truncated SSH archive scans', async () => {
    const archivedRepoNames = Array.from(
      { length: 101 },
      (_, index) => `archived-service-${String(index + 1).padStart(3, '0')}`
    )
    const archivedRepoPaths = archivedRepoNames.map((name) => `/srv/platform/archive/${name}`)
    const gitRepos = new Set(['/srv/platform/z-web-client', ...archivedRepoPaths])

    mockGitProvider.isGitRepoAsync.mockImplementation(async (path: string) => ({
      isRepo: gitRepos.has(path),
      rootPath: null
    }))
    mockFilesystemProvider.stat.mockImplementation(async (path: string) => {
      const repoPath = path.replace(/\/\.git$/, '')
      if (path.endsWith('/.git') && gitRepos.has(repoPath)) {
        return { type: 'directory', size: 0, mtime: 0 }
      }
      throw new Error('not found')
    })
    mockFilesystemProvider.readDir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/srv/platform') {
        return [
          { name: 'archive', isDirectory: true, isSymlink: false },
          { name: 'z-web-client', isDirectory: true, isSymlink: false }
        ]
      }
      if (dirPath === '/srv/platform/archive') {
        return archivedRepoNames.map((name) => ({
          name,
          isDirectory: true,
          isSymlink: false
        }))
      }
      return []
    })

    const result = await handlers.get('projectGroups:scanNested')!(null, {
      path: '/srv/platform',
      connectionId: 'conn-1'
    })

    expect(result).toMatchObject({
      selectedPath: '/srv/platform',
      selectedPathKind: 'non_git_folder',
      truncated: true
    })
    expect((result as { repos: { path: string }[] }).repos).toHaveLength(100)
    expect((result as { repos: { path: string }[] }).repos[0].path).toBe(
      '/srv/platform/z-web-client'
    )
    expect((result as { repos: { path: string }[] }).repos.map((repo) => repo.path)).toContain(
      '/srv/platform/z-web-client'
    )
  })

  it('returns partial SSH scan results after cancellation', async () => {
    mockGitProvider.isGitRepoAsync.mockResolvedValue({ isRepo: false, rootPath: null })
    mockFilesystemProvider.stat.mockImplementation(async (path: string) => {
      if (path === '/srv/platform/api/.git' || path === '/srv/platform/web/.git') {
        return { type: 'directory', size: 0, mtime: 0 }
      }
      throw new Error('not found')
    })
    mockFilesystemProvider.readDir.mockImplementation(async (dirPath: string) =>
      dirPath === '/srv/platform'
        ? [
            { name: 'api', isDirectory: true, isSymlink: false },
            { name: 'web', isDirectory: true, isSymlink: false }
          ]
        : []
    )
    const event = {
      sender: {
        send: vi.fn((_channel: string, data: { scanId: string; scan: { repos: unknown[] } }) => {
          if (data.scan.repos.length === 1) {
            handlers.get('projectGroups:cancelNestedScan')!(null, { scanId: data.scanId })
          }
        })
      }
    }

    const result = await handlers.get('projectGroups:scanNested')!(event, {
      path: '/srv/platform',
      connectionId: 'conn-1',
      scanId: 'scan-1'
    })

    expect(result).toMatchObject({
      selectedPath: '/srv/platform',
      stopped: true,
      repos: [{ path: '/srv/platform/api' }]
    })
    expect(event.sender.send).toHaveBeenCalledWith(
      'projectGroups:scanNestedProgress',
      expect.objectContaining({ scanId: 'scan-1' })
    )
  })

  it('returns partial local scan results after cancellation', async () => {
    vi.mocked(isGitRepo).mockReturnValue(false)
    const root = await mkdtemp(join(tmpdir(), 'orca-nested-local-cancel-'))
    try {
      await mkdir(join(root, 'api', '.git'), { recursive: true })
      await mkdir(join(root, 'web', '.git'), { recursive: true })
      const event = {
        sender: {
          send: vi.fn((_channel: string, data: { scanId: string; scan: { repos: unknown[] } }) => {
            if (data.scan.repos.length === 1) {
              handlers.get('projectGroups:cancelNestedScan')!(null, { scanId: data.scanId })
            }
          })
        }
      }

      const result = await handlers.get('projectGroups:scanNested')!(event, {
        path: root,
        scanId: 'local-scan-1'
      })

      expect(result).toMatchObject({
        selectedPath: root,
        selectedPathKind: 'non_git_folder',
        stopped: true,
        repos: [{ path: join(root, 'api') }]
      })
      expect(event.sender.send).toHaveBeenCalledWith(
        'projectGroups:scanNestedProgress',
        expect.objectContaining({ scanId: 'local-scan-1' })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects local nested scans with relative paths', async () => {
    await expect(
      handlers.get('projectGroups:scanNested')!(null, {
        path: 'relative/project'
      })
    ).rejects.toThrow('Repo path must be an absolute path')
  })
})
