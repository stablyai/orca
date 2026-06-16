/* eslint-disable max-lines -- Why: this file groups all repos IPC handler
tests (addRemote, getBaseRefDefault envelope, searchBaseRefs SSH relay) so
fixture setup and mock plumbing can be shared. Splitting by line count would
duplicate the hoisted mocks and the `../git/repo` partial-real/partial-stub
setup. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type * as RepoModule from '../git/repo'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import { isGitRepo } from '../git/repo'

const {
  handleMock,
  mockStore,
  mockGitProvider,
  mockFilesystemProvider,
  mockMultiplexer,
  gitSpawnMock,
  invalidateAuthorizedRootsCacheMock,
  prepareLocalWorktreeRootForRepoMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mockStore: {
    getRepos: vi.fn().mockReturnValue([]),
    addRepo: vi.fn(),
    removeProject: vi.fn(),
    getRepo: vi.fn(),
    updateRepo: vi.fn(),
    getProjects: vi.fn().mockReturnValue([]),
    getProjectHostSetups: vi.fn().mockReturnValue([]),
    updateProjectHostSetup: vi.fn(),
    getProjectGroups: vi.fn().mockReturnValue([]),
    createProjectGroup: vi.fn(),
    updateProjectGroup: vi.fn(),
    deleteProjectGroup: vi.fn(),
    moveProjectToGroup: vi.fn(),
    getSshTarget: vi.fn()
  },
  mockGitProvider: {
    isGitRepo: vi.fn().mockReturnValue(true),
    isGitRepoAsync: vi.fn().mockResolvedValue({ isRepo: true, rootPath: null }),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    clone: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    getHostPlatform: vi.fn().mockReturnValue({
      relayPlatform: 'linux-x64',
      os: 'linux',
      arch: 'x64',
      pathFlavor: 'posix',
      commandDialect: 'posix',
      pathSeparator: '/',
      pathDelimiter: ':'
    })
  },
  mockFilesystemProvider: {
    readDir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockRejectedValue(new Error('not found')),
    stat: vi.fn().mockRejectedValue(new Error('not found')),
    createDir: vi.fn().mockResolvedValue(undefined),
    createDirNoClobber: vi.fn().mockResolvedValue(undefined),
    deletePath: vi.fn().mockResolvedValue(undefined)
  },
  mockMultiplexer: {
    request: vi.fn(),
    notify: vi.fn()
  },
  gitSpawnMock: vi.fn(),
  invalidateAuthorizedRootsCacheMock: vi.fn(),
  prepareLocalWorktreeRootForRepoMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: handleMock,
    removeHandler: vi.fn()
  }
}))

vi.mock('../git/repo', async () => {
  // Why: pull real implementations of pure helpers so SSH parity tests
  // exercise the actual probe list and query sanitizer, not frozen copies.
  // Drift in DEFAULT_BASE_REF_PROBES or normalizeRefSearchQuery now surfaces
  // as test failure, not silent test-passes against stale behavior.
  const actual = await vi.importActual<typeof RepoModule>('../git/repo')
  return {
    ...actual,
    // Stub only the functions that spawn git / touch the filesystem.
    isGitRepo: vi.fn().mockReturnValue(true),
    getGitUsername: vi.fn().mockReturnValue(''),
    getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
    getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
    getRemoteCount: vi.fn().mockResolvedValue(1),
    searchBaseRefs: vi.fn().mockResolvedValue([])
  }
})

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(),
  gitSpawn: gitSpawnMock
}))

vi.mock('./filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: invalidateAuthorizedRootsCacheMock
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: prepareLocalWorktreeRootForRepoMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn().mockImplementation((id: string) => {
    if (id === 'conn-1') {
      return mockGitProvider
    }
    return undefined
  })
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn().mockImplementation((id: string) => {
    if (id === 'conn-1') {
      return mockFilesystemProvider
    }
    return undefined
  })
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: vi.fn().mockImplementation((id: string) => {
    if (id === 'conn-1') {
      return mockMultiplexer
    }
    return undefined
  })
}))

import { registerRepoHandlers } from './repos'

describe('projectGroups IPC validation', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    mockWindow.webContents.send.mockReset()
    mockStore.createProjectGroup.mockReset()
    mockStore.updateProjectGroup.mockReset()
    mockStore.deleteProjectGroup.mockReset()
    mockStore.moveProjectToGroup.mockReset()
    mockStore.getProjects.mockReset().mockReturnValue([])
    mockStore.getProjectHostSetups.mockReset().mockReturnValue([])
    mockStore.updateProjectHostSetup.mockReset()
    mockStore.getRepos.mockReset()
    mockStore.getRepos.mockReturnValue([])
    mockFilesystemProvider.readDir.mockReset()
    mockFilesystemProvider.readDir.mockResolvedValue([])
    mockFilesystemProvider.readFile.mockReset()
    mockFilesystemProvider.readFile.mockRejectedValue(new Error('not found'))
    mockFilesystemProvider.stat.mockReset()
    mockFilesystemProvider.stat.mockRejectedValue(new Error('not found'))
    mockGitProvider.isGitRepoAsync.mockReset()
    mockGitProvider.isGitRepoAsync.mockResolvedValue({ isRepo: true, rootPath: null })
    vi.mocked(isGitRepo).mockReset()
    vi.mocked(isGitRepo).mockReturnValue(true)
    mockMultiplexer.notify.mockReset()
    mockMultiplexer.request.mockReset()
    invalidateAuthorizedRootsCacheMock.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('rejects malformed local project group create arguments before persistence', () => {
    expect(() =>
      handlers.get('projectGroups:create')!(null, { name: 123, createdFrom: 'unexpected' })
    ).toThrow('invalid_project_group_create_args')

    expect(mockStore.createProjectGroup).not.toHaveBeenCalled()
  })

  it('rejects malformed local project group update arguments before persistence', () => {
    expect(() =>
      handlers.get('projectGroups:update')!(null, {
        groupId: 'group-1',
        updates: { isCollapsed: 'yes' }
      })
    ).toThrow('invalid_project_group_update_args')

    expect(mockStore.updateProjectGroup).not.toHaveBeenCalled()
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

  it('uses completed scan ids as an allowlist for nested imports', async () => {
    const group = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/srv/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    mockStore.createProjectGroup.mockReturnValue(group)
    mockGitProvider.isGitRepoAsync.mockImplementation(async (path: string) => ({
      isRepo: path === '/srv/platform/api' || path === '/srv/platform/node_modules/hidden',
      rootPath: null
    }))
    mockFilesystemProvider.stat.mockImplementation(async (path: string) => {
      if (path === '/srv/platform/api/.git') {
        return { type: 'directory', size: 0, mtime: 0 }
      }
      if (path === '/srv/platform/node_modules/hidden/.git') {
        return { type: 'directory', size: 0, mtime: 0 }
      }
      throw new Error('not found')
    })
    mockFilesystemProvider.readDir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/srv/platform') {
        return [
          { name: 'api', isDirectory: true, isSymlink: false },
          { name: 'node_modules', isDirectory: true, isSymlink: false }
        ]
      }
      return []
    })

    await handlers.get('projectGroups:scanNested')!(
      { sender: { send: vi.fn() } },
      {
        path: '/srv/platform',
        connectionId: 'conn-1',
        scanId: 'scan-import-allowlist'
      }
    )

    const result = await handlers.get('projectGroups:importNested')!(null, {
      parentPath: '/srv/platform',
      groupName: 'Platform',
      projectPaths: ['/srv/platform/api', '/srv/platform/node_modules/hidden'],
      connectionId: 'conn-1',
      scanId: 'scan-import-allowlist',
      mode: 'group'
    })

    expect(result).toMatchObject({ importedCount: 1, failedCount: 1 })
    expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/srv/platform/api' })
    )
  })

  it('does not reuse a completed nested scan id for a different SSH parent path', async () => {
    const group = {
      id: 'group-1',
      name: 'Other',
      parentPath: '/srv/other',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    mockStore.createProjectGroup.mockReturnValue(group)
    mockGitProvider.isGitRepoAsync.mockImplementation(async (path: string) => ({
      isRepo: path === '/srv/platform/api' || path === '/srv/other/api',
      rootPath: null
    }))
    mockFilesystemProvider.stat.mockImplementation(async (path: string) => {
      if (path === '/srv/platform/api/.git' || path === '/srv/other/api/.git') {
        return { type: 'directory', size: 0, mtime: 0 }
      }
      throw new Error('not found')
    })
    mockFilesystemProvider.readDir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/srv/platform' || dirPath === '/srv/other') {
        return [{ name: 'api', isDirectory: true, isSymlink: false }]
      }
      return []
    })

    await handlers.get('projectGroups:scanNested')!(
      { sender: { send: vi.fn() } },
      {
        path: '/srv/platform',
        connectionId: 'conn-1',
        scanId: 'scan-parent-context'
      }
    )
    mockStore.addRepo.mockClear()

    const result = await handlers.get('projectGroups:importNested')!(null, {
      parentPath: '/srv/other',
      groupName: 'Other',
      projectPaths: ['/srv/platform/api'],
      connectionId: 'conn-1',
      scanId: 'scan-parent-context',
      mode: 'group'
    })

    expect(result).toMatchObject({ importedCount: 0, failedCount: 1 })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
    expect(mockFilesystemProvider.readDir).toHaveBeenCalledWith('/srv/other')
  })

  it('does not reuse a completed nested scan id for a different SSH connection', async () => {
    const group = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/srv/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    mockStore.createProjectGroup.mockReturnValue(group)
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

    await handlers.get('projectGroups:scanNested')!(
      { sender: { send: vi.fn() } },
      {
        path: '/srv/platform',
        connectionId: 'conn-1',
        scanId: 'scan-connection-context'
      }
    )
    mockStore.addRepo.mockClear()

    await expect(
      handlers.get('projectGroups:importNested')!(null, {
        parentPath: '/srv/platform',
        groupName: 'Platform',
        projectPaths: ['/srv/platform/api'],
        connectionId: 'missing-conn',
        scanId: 'scan-connection-context',
        mode: 'group'
      })
    ).rejects.toThrow('ssh_connection_unavailable')

    expect(mockStore.addRepo).not.toHaveBeenCalled()
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

  it('imports nested SSH repositories with connection-scoped repo entries', async () => {
    const group = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/srv/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    mockStore.createProjectGroup.mockReturnValue(group)
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

    const result = await handlers.get('projectGroups:importNested')!(null, {
      parentPath: '/srv/platform',
      groupName: 'Platform',
      projectPaths: ['/srv/platform/api'],
      connectionId: 'conn-1',
      mode: 'group'
    })

    expect(result).toMatchObject({ importedCount: 1, failedCount: 0 })
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/srv/platform/api',
        connectionId: 'conn-1',
        projectGroupId: group.id
      })
    )
    expect(mockMultiplexer.notify).toHaveBeenCalledWith('session.registerRoot', {
      rootPath: '/srv/platform/api'
    })
  })

  it('imports a small selection from a large nested SSH scan', async () => {
    const group = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/srv/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const repoPaths = Array.from(
      { length: 87 },
      (_, index) => `/srv/platform/service-${String(index + 1).padStart(2, '0')}`
    )
    const selectedPaths = [repoPaths[2], repoPaths[41], repoPaths[86]]
    mockStore.addRepo.mockClear()
    mockStore.createProjectGroup.mockReturnValue(group)
    mockGitProvider.isGitRepoAsync.mockImplementation(async (path: string) => ({
      isRepo: repoPaths.includes(path),
      rootPath: null
    }))
    mockFilesystemProvider.stat.mockImplementation(async (path: string) => {
      const repoPath = path.replace(/\/\.git$/, '')
      if (path.endsWith('/.git') && repoPaths.includes(repoPath)) {
        return { type: 'directory', size: 0, mtime: 0 }
      }
      throw new Error('not found')
    })
    mockFilesystemProvider.readDir.mockImplementation(async (dirPath: string) =>
      dirPath === '/srv/platform'
        ? repoPaths.map((repoPath) => ({
            name: repoPath.split('/').at(-1) ?? repoPath,
            isDirectory: true,
            isSymlink: false
          }))
        : []
    )

    const result = await handlers.get('projectGroups:importNested')!(null, {
      parentPath: '/srv/platform',
      groupName: 'Platform',
      projectPaths: selectedPaths,
      connectionId: 'conn-1',
      mode: 'group'
    })

    expect(result).toMatchObject({
      importedCount: 3,
      alreadyKnownCount: 0,
      failedCount: 0
    })
    expect(mockStore.addRepo).toHaveBeenCalledTimes(3)
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({ path: selectedPaths[0], projectGroupId: group.id })
    )
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({ path: selectedPaths[1], projectGroupId: group.id })
    )
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({ path: selectedPaths[2], projectGroupId: group.id })
    )
  })

  it('sanitizes unexpected nested import errors before returning results', async () => {
    const group = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/srv/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    mockStore.createProjectGroup.mockReturnValue(group)
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
    mockStore.addRepo.mockImplementationOnce(() => {
      throw new Error('secret backend path /srv/platform/api')
    })

    const result = (await handlers.get('projectGroups:importNested')!(null, {
      parentPath: '/srv/platform',
      groupName: 'Platform',
      projectPaths: ['/srv/platform/api'],
      connectionId: 'conn-1',
      mode: 'group'
    })) as { projects: { error?: string }[] }

    expect(result.projects[0].error).toBe('Repository could not be imported')
  })
})

describe('repos:getGitUsername', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    mockStore.getRepo.mockReset()
    mockGitProvider.exec.mockReset()
    mockWindow.webContents.send.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('uses explicit SSH username config instead of remote author identity', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'git',
      connectionId: 'conn-1'
    })
    mockGitProvider.exec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') {
        const valueByKey: Record<string, string> = {
          'user.username': 'remote-login',
          'user.email': 'remote-user@example.com',
          'user.name': 'Remote User'
        }
        const value = valueByKey[args[2]]
        if (value) {
          return { stdout: `${value}\n`, stderr: '' }
        }
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const username = await handlers.get('repos:getGitUsername')!(null, { repoId: 'repo-ssh' })

    expect(username).toBe('remote-login')
    expect(mockGitProvider.exec).toHaveBeenCalledWith(
      ['config', '--get', 'github.user'],
      '/remote/repo'
    )
    expect(mockGitProvider.exec).toHaveBeenCalledWith(
      ['config', '--get', 'user.username'],
      '/remote/repo'
    )
    expect(mockGitProvider.exec).not.toHaveBeenCalledWith(
      ['config', '--get', 'user.email'],
      '/remote/repo'
    )
    expect(mockGitProvider.exec).not.toHaveBeenCalledWith(
      ['config', '--get', 'user.name'],
      '/remote/repo'
    )
  })
})

describe('repos:addRemote', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.addRepo.mockReset()
    mockStore.getSshTarget.mockReset()
    mockStore.updateRepo.mockReset()
    mockGitProvider.isGitRepoAsync.mockReset()
    mockGitProvider.isGitRepoAsync.mockResolvedValue({ isRepo: true, rootPath: null })
    mockGitProvider.exec.mockReset()
    mockGitProvider.exec.mockResolvedValue({ stdout: '', stderr: '' })
    mockGitProvider.clone.mockReset()
    mockGitProvider.clone.mockResolvedValue({ stdout: '', stderr: '' })
    mockGitProvider.getHostPlatform.mockReset()
    mockGitProvider.getHostPlatform.mockReturnValue({
      relayPlatform: 'linux-x64',
      os: 'linux',
      arch: 'x64',
      pathFlavor: 'posix',
      commandDialect: 'posix',
      pathSeparator: '/',
      pathDelimiter: ':'
    })
    mockFilesystemProvider.stat.mockReset()
    mockFilesystemProvider.stat.mockRejectedValue(new Error('not found'))
    mockFilesystemProvider.createDirNoClobber.mockReset()
    mockFilesystemProvider.createDirNoClobber.mockResolvedValue(undefined)
    mockFilesystemProvider.deletePath.mockReset()
    mockFilesystemProvider.deletePath.mockResolvedValue(undefined)
    mockMultiplexer.request.mockReset()
    mockMultiplexer.notify.mockReset()
    gitSpawnMock.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
    gitSpawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc
    })
    mockWindow.webContents.send.mockReset()

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('registers the repos:addRemote handler', () => {
    expect(handlers.has('repos:addRemote')).toBe(true)
  })

  it('registers the repos:cloneRemote handler', () => {
    expect(handlers.has('repos:cloneRemote')).toBe(true)
  })

  it('registers the repos:createRemote handler', () => {
    expect(handlers.has('repos:createRemote')).toBe(true)
  })

  it('creates a remote repo with connectionId', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/user/project',
        connectionId: 'conn-1',
        kind: 'git',
        displayName: 'project',
        badgeColor: DEFAULT_REPO_BADGE_COLOR,
        externalWorktreeVisibility: 'hide',
        externalWorktreeVisibilityLegacy: false,
        projectHostSetupMethod: 'imported-existing-folder'
      })
    )
    expect(result).toHaveProperty('repo.id')
    expect(result).toHaveProperty('repo.connectionId', 'conn-1')
    expect(result).toHaveProperty('repo.externalWorktreeVisibility', 'hide')
  })

  it('uses custom displayName when provided', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project',
      displayName: 'My Server Repo'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'My Server Repo',
        path: '/home/user/project'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'My Server Repo')
  })

  it('clones a repo on an SSH target and registers the cloned path', async () => {
    const result = await handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })

    expect(mockFilesystemProvider.createDir).toHaveBeenCalledWith('/home/user')
    expect(mockGitProvider.clone).toHaveBeenCalledWith(
      ['clone', '--progress', '--', 'https://github.com/stablyai/orca.git', 'orca'],
      '/home/user',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: 10 * 60_000,
        onProgress: expect.any(Function)
      })
    )
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/user/orca',
        connectionId: 'conn-1',
        kind: 'git',
        displayName: 'orca',
        badgeColor: DEFAULT_REPO_BADGE_COLOR,
        externalWorktreeVisibility: 'hide',
        externalWorktreeVisibilityLegacy: false
      })
    )
    expect(mockMultiplexer.notify).toHaveBeenCalledWith('session.registerRoot', {
      rootPath: '/home/user/orca'
    })
    expect(result).toHaveProperty('path', '/home/user/orca')
    expect(result).toHaveProperty('connectionId', 'conn-1')
  })

  it('forwards SSH clone progress through the existing clone progress event', async () => {
    mockGitProvider.clone.mockImplementationOnce(
      async (
        _args: string[],
        _cwd: string,
        options?: { onProgress?: (progress: { phase: string; percent: number }) => void }
      ) => {
        options?.onProgress?.({ phase: 'Receiving objects', percent: 42 })
        return { stdout: '', stderr: '' }
      }
    )

    await handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })

    expect(mockWindow.webContents.send).toHaveBeenCalledWith('repos:clone-progress', {
      phase: 'Receiving objects',
      percent: 42
    })
  })

  it('returns an existing SSH repo instead of cloning the same target again', async () => {
    const existing = {
      id: 'existing-id',
      path: '/home/user/orca',
      connectionId: 'conn-1',
      displayName: 'orca',
      badgeColor: '#fff',
      addedAt: 1000,
      kind: 'git'
    }
    mockStore.getRepos.mockReturnValue([existing])

    const result = await handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })

    expect(result).toBe(existing)
    expect(mockGitProvider.clone).not.toHaveBeenCalled()
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('upgrades an existing SSH folder repo after cloning into that path', async () => {
    const existing = {
      id: 'existing-folder',
      path: '/home/user/orca',
      connectionId: 'conn-1',
      displayName: 'orca',
      badgeColor: '#fff',
      addedAt: 1000,
      kind: 'folder'
    }
    const updated = { ...existing, kind: 'git' }
    mockStore.getRepos.mockReturnValue([existing])
    mockStore.updateRepo.mockReturnValue(updated)

    const result = await handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })

    expect(mockGitProvider.clone).toHaveBeenCalledWith(
      ['clone', '--progress', '--', 'https://github.com/stablyai/orca.git', 'orca'],
      '/home/user',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: 10 * 60_000,
        onProgress: expect.any(Function)
      })
    )
    expect(mockStore.updateRepo).toHaveBeenCalledWith('existing-folder', {
      kind: 'git',
      projectHostSetupMethod: 'cloned'
    })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
    expect(result).toBe(updated)
  })

  it('does not delete a fresh SSH clone target after git clone fails', async () => {
    mockGitProvider.clone.mockRejectedValueOnce(new Error('repository not found'))
    mockFilesystemProvider.stat.mockRejectedValueOnce(new Error('not found'))

    await expect(
      handlers.get('repos:cloneRemote')!(null, {
        connectionId: 'conn-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/home/user'
      })
    ).rejects.toThrow('repository not found')

    expect(mockFilesystemProvider.deletePath).not.toHaveBeenCalled()
  })

  it('rejects concurrent SSH clones to the same destination', async () => {
    let releaseClone!: () => void
    mockGitProvider.clone.mockImplementationOnce(
      async () =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          releaseClone = () => resolve({ stdout: '', stderr: '' })
        })
    )

    const firstClone = handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })
    await waitForAssertion(() => expect(mockGitProvider.clone).toHaveBeenCalledTimes(1))

    await expect(
      handlers.get('repos:cloneRemote')!(null, {
        connectionId: 'conn-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/home/user'
      })
    ).rejects.toThrow('A clone is already in progress for this SSH destination')

    releaseClone()
    await firstClone
  })

  it('resolves SSH clone destinations under home before validating the path', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu/projects' })

    await handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '~/projects'
    })

    expect(mockMultiplexer.request).toHaveBeenCalledWith('session.resolveHome', {
      path: '~/projects'
    })
    expect(mockGitProvider.clone).toHaveBeenCalledWith(
      ['clone', '--progress', '--', 'https://github.com/stablyai/orca.git', 'orca'],
      '/home/ubuntu/projects',
      expect.any(Object)
    )
  })

  it('does not clean up a pre-existing SSH clone target after git clone fails', async () => {
    mockGitProvider.clone.mockRejectedValueOnce(new Error('destination already exists'))
    mockFilesystemProvider.stat.mockResolvedValueOnce({ type: 'directory', size: 0, mtime: 0 })

    await expect(
      handlers.get('repos:cloneRemote')!(null, {
        connectionId: 'conn-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/home/user'
      })
    ).rejects.toThrow('destination already exists')

    expect(mockFilesystemProvider.deletePath).not.toHaveBeenCalled()
  })

  it('aborts an active SSH clone and reports the abort without deleting pre-existing targets', async () => {
    mockFilesystemProvider.stat.mockResolvedValueOnce({ type: 'directory', size: 0, mtime: 0 })
    mockGitProvider.clone.mockImplementationOnce(
      async (_args: string[], _cwd: string, options?: { signal?: AbortSignal }) =>
        new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted by test')))
        })
    )

    const clonePromise = handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })
    await waitForAssertion(() => expect(mockGitProvider.clone).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)

    await expect(clonePromise).rejects.toThrow('Clone aborted')
    const options = mockGitProvider.clone.mock.calls[0][2] as { signal: AbortSignal }
    expect(options.signal.aborted).toBe(true)
    expect(mockFilesystemProvider.deletePath).not.toHaveBeenCalled()
  })

  it('rejects SSH clone destinations that are not absolute host paths', async () => {
    await expect(
      handlers.get('repos:cloneRemote')!(null, {
        connectionId: 'conn-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: 'relative/path'
      })
    ).rejects.toThrow('Clone destination must be an absolute path on the SSH host')

    expect(mockGitProvider.clone).not.toHaveBeenCalled()
  })

  it('creates a new git project on an SSH target', async () => {
    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '/home/user',
      name: 'created',
      kind: 'git'
    })

    expect(mockFilesystemProvider.createDirNoClobber).toHaveBeenCalledWith('/home/user/created')
    expect(mockGitProvider.exec).toHaveBeenCalledWith(['init'], '/home/user/created')
    expect(mockGitProvider.exec).toHaveBeenCalledWith(
      ['commit', '--allow-empty', '-m', 'Initial commit'],
      '/home/user/created'
    )
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/user/created',
        connectionId: 'conn-1',
        kind: 'git',
        displayName: 'created',
        externalWorktreeVisibility: 'hide'
      })
    )
    expect(result).toHaveProperty('repo.path', '/home/user/created')
    expect(result).toHaveProperty('repo.connectionId', 'conn-1')
  })

  it('resolves SSH create parents under home before validating the path', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu/projects' })

    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '~/projects',
      name: 'created',
      kind: 'folder'
    })

    expect(mockMultiplexer.request).toHaveBeenCalledWith('session.resolveHome', {
      path: '~/projects'
    })
    expect(mockFilesystemProvider.createDirNoClobber).toHaveBeenCalledWith(
      '/home/ubuntu/projects/created'
    )
    expect(result).toHaveProperty('repo.path', '/home/ubuntu/projects/created')
  })

  it('creates a new folder project on an SSH target without git init', async () => {
    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '/home/user',
      name: 'notes',
      kind: 'folder'
    })

    expect(mockFilesystemProvider.createDirNoClobber).toHaveBeenCalledWith('/home/user/notes')
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/user/notes',
        connectionId: 'conn-1',
        kind: 'folder',
        displayName: 'notes'
      })
    )
    expect(result).toHaveProperty('repo.kind', 'folder')
  })

  it('rejects SSH create parent paths that are not absolute host paths', async () => {
    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: 'relative/path',
      name: 'created',
      kind: 'git'
    })

    expect(result).toEqual({ error: 'Parent directory must be an absolute path on the SSH host' })
    expect(mockFilesystemProvider.createDirNoClobber).not.toHaveBeenCalled()
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
  })

  it('rejects non-empty existing SSH create targets', async () => {
    mockFilesystemProvider.stat.mockResolvedValueOnce({ type: 'directory', size: 0, mtime: 0 })
    mockFilesystemProvider.readDir.mockResolvedValueOnce([
      { name: 'package.json', isDirectory: false, isSymlink: false }
    ])

    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '/home/user',
      name: 'created',
      kind: 'git'
    })

    expect(result).toEqual({
      error: '"created" already exists at this location and is not empty.'
    })
    expect(mockFilesystemProvider.createDirNoClobber).not.toHaveBeenCalled()
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
  })

  it('removes a newly created SSH directory when git init fails', async () => {
    mockGitProvider.exec.mockRejectedValueOnce(new Error('git init failed'))

    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '/home/user',
      name: 'created',
      kind: 'git'
    })

    expect(result).toEqual({ error: 'Failed to initialize git repository: git init failed' })
    expect(mockFilesystemProvider.deletePath).toHaveBeenCalledWith('/home/user/created', true)
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('preserves an existing empty SSH directory and removes only .git when commit fails', async () => {
    mockFilesystemProvider.stat.mockResolvedValueOnce({ type: 'directory', size: 0, mtime: 0 })
    mockFilesystemProvider.readDir.mockResolvedValueOnce([])
    mockGitProvider.exec
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('Please tell me who you are'))

    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '/home/user',
      name: 'created',
      kind: 'git'
    })

    expect(result).toEqual({
      error:
        'Git author identity is not configured on the SSH host. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` on that host, then try again.'
    })
    expect(mockFilesystemProvider.deletePath).toHaveBeenCalledWith('/home/user/created/.git', true)
    expect(mockFilesystemProvider.deletePath).not.toHaveBeenCalledWith('/home/user/created', true)
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('returns existing repo if same connectionId and path already added', async () => {
    const existing = {
      id: 'existing-id',
      path: '/home/user/project',
      connectionId: 'conn-1',
      displayName: 'project',
      badgeColor: '#fff',
      addedAt: 1000,
      kind: 'git'
    }
    mockStore.getRepos.mockReturnValue([existing])

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project'
    })

    expect(result).toEqual({ repo: existing })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('throws when SSH connection is not found', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'unknown-conn',
      remotePath: '/home/user/project'
    })
    expect(result).toEqual({ error: 'SSH connection "unknown-conn" not found or not connected' })
  })

  it('throws when remote path is not a git repo', async () => {
    mockGitProvider.isGitRepoAsync.mockResolvedValueOnce({ isRepo: false, rootPath: null })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/documents'
    })
    expect(result).toEqual({ error: 'Not a valid git repository: /home/user/documents' })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('adds as folder when kind is explicitly set', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/documents',
      kind: 'folder'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'folder',
        path: '/home/user/documents',
        badgeColor: DEFAULT_REPO_BADGE_COLOR
      })
    )
    expect(result).toHaveProperty('repo.kind', 'folder')
  })

  it('uses rootPath from git detection when available', async () => {
    mockGitProvider.isGitRepoAsync.mockResolvedValueOnce({
      isRepo: true,
      rootPath: '/home/user/project'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project/src'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'git',
        path: '/home/user/project'
      })
    )
    expect(result).toHaveProperty('repo.path', '/home/user/project')
  })

  it('uses the resolved git root basename for the default remote display name', async () => {
    mockGitProvider.isGitRepoAsync.mockResolvedValueOnce({
      isRepo: true,
      rootPath: '/home/user/project'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project/src'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/user/project',
        displayName: 'project'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'project')
  })

  it('derives default remote display names from Windows path separators', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: 'C:\\Users\\alice\\project',
      kind: 'folder'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'C:\\Users\\alice\\project',
        displayName: 'project'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'project')
  })

  it('notifies renderer when remote repo is added', async () => {
    await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project'
    })

    expect(mockWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
  })

  it('resolves ~ to absolute path via relay and uses SSH target label', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu' })
    mockStore.getSshTarget.mockReturnValueOnce({
      id: 'conn-1',
      label: 'ubuntu-box',
      host: '192.168.1.100',
      port: 22,
      username: 'user'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '~'
    })

    expect(mockMultiplexer.request).toHaveBeenCalledWith('session.resolveHome', { path: '~' })
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'ubuntu-box',
        path: '/home/ubuntu'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'ubuntu-box')
    expect(result).toHaveProperty('repo.path', '/home/ubuntu')
  })

  it('resolves ~/subdir to absolute path via relay', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu/subdir' })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '~/subdir'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/ubuntu/subdir',
        displayName: 'subdir'
      })
    )
    expect(result).toHaveProperty('repo.path', '/home/ubuntu/subdir')
  })

  it('returns an existing SSH repo when a selected subdirectory resolves to the repo root', async () => {
    const existing = {
      id: 'existing-id',
      path: '/home/user/orca',
      connectionId: 'conn-1',
      displayName: 'orca',
      badgeColor: '#fff',
      addedAt: 1000,
      kind: 'git'
    }
    mockStore.getRepos.mockReturnValue([existing])
    mockGitProvider.isGitRepoAsync.mockResolvedValueOnce({
      isRepo: true,
      rootPath: '/home/user/orca'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/orca/src'
    })

    expect(result).toEqual({ repo: existing })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('ignores SSH target label when custom displayName is provided', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu' })
    mockStore.getSshTarget.mockReturnValueOnce({
      id: 'conn-1',
      label: 'ubuntu-box',
      host: '192.168.1.100',
      port: 22,
      username: 'user'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '~',
      displayName: 'My Home'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'My Home',
        path: '/home/ubuntu'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'My Home')
  })
})

type MockCloneProcess = EventEmitter & {
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function createMockCloneProcess(): MockCloneProcess {
  const proc = new EventEmitter() as MockCloneProcess
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn().mockReturnValue(true)
  return proc
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

describe('repos:add + repos:clone', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
  const tempRoots: string[] = []

  const createTempRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'orca-repos-clone-'))
    tempRoots.push(root)
    return root
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.addRepo.mockReset()
    mockStore.updateRepo.mockReset()
    mockStore.getProjects.mockReset().mockReturnValue([])
    mockStore.getProjectHostSetups.mockReset().mockReturnValue([])
    mockStore.updateProjectHostSetup.mockReset()
    mockWindow.webContents.send.mockReset()
    gitSpawnMock.mockReset()
    invalidateAuthorizedRootsCacheMock.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
    gitSpawnMock.mockImplementation(() => {
      const proc = createMockCloneProcess()
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc
    })

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('defaults repos:add badgeColor to DEFAULT_REPO_BADGE_COLOR for folder repos', async () => {
    const result = await handlers.get('repos:add')!(null, { path: '/tmp/from-add', kind: 'folder' })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/tmp/from-add', badgeColor: DEFAULT_REPO_BADGE_COLOR })
    )
    expect(result).toHaveProperty('repo.badgeColor', DEFAULT_REPO_BADGE_COLOR)
  })

  it('defaults new git repos:add records to hiding non-Orca worktrees', async () => {
    const result = await handlers.get('repos:add')!(null, { path: '/tmp/from-add', kind: 'git' })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/tmp/from-add',
        kind: 'git',
        externalWorktreeVisibility: 'hide',
        externalWorktreeVisibilityLegacy: false,
        projectHostSetupMethod: 'imported-existing-folder'
      })
    )
    expect(result).toHaveProperty('repo.externalWorktreeVisibility', 'hide')
  })

  it('prepares the worktree root when adding a local git repo', async () => {
    await handlers.get('repos:add')!(null, { path: '/tmp/from-add', kind: 'git' })

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(
      mockStore,
      expect.objectContaining({ path: '/tmp/from-add', kind: 'git' })
    )
  })

  it('returns existing badgeColor unchanged on repos:add dedupe', async () => {
    const existing = {
      id: 'repo-add-existing',
      path: '/tmp/from-add-existing',
      displayName: 'from-add-existing',
      kind: 'folder',
      badgeColor: '#22c55e',
      externalWorktreeVisibility: 'show'
    }
    mockStore.getRepos.mockReturnValue([existing])

    const result = await handlers.get('repos:add')!(null, {
      path: '/tmp/from-add-existing',
      kind: 'folder'
    })

    expect(result).toEqual({ repo: existing })
    expect(result).toHaveProperty('repo.badgeColor', '#22c55e')
    expect(result).toHaveProperty('repo.externalWorktreeVisibility', 'show')
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('prepares the worktree root when repos:add returns an existing local git repo', async () => {
    const existing = {
      id: 'repo-add-existing-git',
      path: '/tmp/from-add-existing-git',
      displayName: 'from-add-existing-git',
      kind: 'git',
      badgeColor: '#22c55e'
    }
    mockStore.getRepos.mockReturnValue([existing])

    await handlers.get('repos:add')!(null, {
      path: '/tmp/from-add-existing-git',
      kind: 'git'
    })

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(mockStore, existing)
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('prepares the aligned worktree root when project setup uses an existing local git repo', async () => {
    const existing = {
      id: 'repo-setup-existing-git',
      path: '/tmp/from-setup-existing-git',
      displayName: 'from-setup-existing-git',
      kind: 'git',
      badgeColor: '#22c55e'
    }
    const aligned = { ...existing, projectHostSetupMethod: 'imported-existing-folder' }
    const project = { id: 'project-1', displayName: 'Project' }
    const setup = {
      id: 'setup-1',
      projectId: project.id,
      repoId: existing.id,
      hostId: 'local',
      path: existing.path,
      displayName: existing.displayName,
      setupState: 'ready',
      setupMethod: 'imported-existing-folder'
    }
    mockStore.getRepos.mockReturnValue([existing])
    mockStore.getProjects.mockReturnValue([project])
    mockStore.getProjectHostSetups.mockReturnValue([setup])
    mockStore.updateRepo.mockReturnValue(aligned)

    await handlers.get('projectHostSetups:setupExistingFolder')!(null, {
      projectId: project.id,
      hostId: 'local',
      path: existing.path,
      kind: 'git',
      setupMethod: 'imported-existing-folder'
    })

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(mockStore, aligned)
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('prepares and invalidates roots when repos:update changes worktree base path', () => {
    const updated = {
      id: 'repo-update-root',
      path: '/tmp/repo-update-root',
      displayName: 'repo-update-root',
      kind: 'git',
      badgeColor: '#22c55e',
      worktreeBasePath: '../worktrees'
    }
    mockStore.updateRepo.mockReturnValue(updated)

    const result = handlers.get('repos:update')!(null, {
      repoId: updated.id,
      updates: { worktreeBasePath: ' ../worktrees ' }
    })

    expect(result).toBe(updated)
    expect(mockStore.updateRepo).toHaveBeenCalledWith(updated.id, {
      worktreeBasePath: '../worktrees'
    })
    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(mockStore, updated)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('prepares and invalidates roots when project host setup update changes worktree base path', () => {
    const repo = {
      id: 'repo-setup-update-root',
      path: '/tmp/repo-setup-update-root',
      displayName: 'repo-setup-update-root',
      kind: 'git',
      badgeColor: '#22c55e',
      worktreeBasePath: '../worktrees'
    }
    const result = {
      project: { id: 'project-1', displayName: 'Project' },
      setup: { id: 'setup-1', projectId: 'project-1', repoId: repo.id, hostId: 'local' },
      repo
    }
    mockStore.updateProjectHostSetup.mockReturnValue(result)

    expect(
      handlers.get('projectHostSetups:update')!(null, {
        setupId: 'setup-1',
        updates: { worktreeBasePath: '../worktrees' }
      })
    ).toBe(result)

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(mockStore, repo)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('dedupes repos:add by normalized local path on Windows', async () => {
    const existing = {
      id: 'repo-add-windows-existing',
      path: 'C:\\Users\\Ava\\Repo',
      displayName: 'Repo',
      kind: 'folder',
      badgeColor: '#22c55e'
    }
    mockStore.getRepos.mockReturnValue([existing])

    const result = await handlers.get('repos:add')!(null, {
      path: 'c:/Users/Ava/Repo',
      kind: 'folder'
    })

    expect(result).toEqual({ repo: existing })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('defaults repos:clone badgeColor to DEFAULT_REPO_BADGE_COLOR', async () => {
    const destination = await createTempRoot()

    const result = await handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: join(destination, 'orca'),
        badgeColor: DEFAULT_REPO_BADGE_COLOR,
        kind: 'git',
        externalWorktreeVisibility: 'hide',
        externalWorktreeVisibilityLegacy: false
      })
    )
    expect(result).toHaveProperty('badgeColor', DEFAULT_REPO_BADGE_COLOR)
    expect(result).toHaveProperty('externalWorktreeVisibility', 'hide')
  })

  it('preserves existing badgeColor when repos:clone upgrades folder->git after dedupe', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const existing = {
      id: 'folder-repo',
      path: clonePath,
      displayName: 'orca',
      badgeColor: '#8b5cf6',
      addedAt: 1,
      kind: 'folder'
    }
    const upgraded = { ...existing, kind: 'git' as const }
    mockStore.getRepos.mockReturnValue([existing])
    mockStore.updateRepo.mockReturnValue(upgraded)

    const result = await handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })

    expect(mockStore.updateRepo).toHaveBeenCalledWith(existing.id, {
      kind: 'git',
      projectHostSetupMethod: 'cloned'
    })
    expect(result).toEqual(upgraded)
    expect(result).toHaveProperty('badgeColor', '#8b5cf6')
    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(mockStore, upgraded)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('rejects a dot-segment URL before creating the destination or spawning git', async () => {
    const tempRoot = await createTempRoot()
    const destination = join(tempRoot, 'destination')

    await expect(
      handlers.get('repos:clone')!(null, {
        url: 'file:///tmp/source/.',
        destination
      })
    ).rejects.toThrow('Invalid repository name derived from URL')

    expect(existsSync(destination)).toBe(false)
    expect(gitSpawnMock).not.toHaveBeenCalled()
  })

  it('rejects a parent-segment URL before creating the destination or spawning git', async () => {
    const tempRoot = await createTempRoot()
    const destination = join(tempRoot, 'destination')

    await expect(
      handlers.get('repos:clone')!(null, {
        url: 'file:///tmp/source/..',
        destination
      })
    ).rejects.toThrow('Invalid repository name derived from URL')

    expect(existsSync(destination)).toBe(false)
    expect(gitSpawnMock).not.toHaveBeenCalled()
  })

  it('rejects a relative destination before creating directories or spawning git', async () => {
    const destination = `relative-clone-destination-${Date.now()}`

    await expect(
      handlers.get('repos:clone')!(null, {
        url: 'https://example.com/orca.git',
        destination
      })
    ).rejects.toThrow('Clone destination must be an absolute path')

    expect(existsSync(destination)).toBe(false)
    expect(gitSpawnMock).not.toHaveBeenCalled()
  })

  it('rejects URL-derived names containing Windows separators before spawning git', async () => {
    const destination = await createTempRoot()

    await expect(
      handlers.get('repos:clone')!(null, {
        url: 'https://example.com/team\\orca.git',
        destination
      })
    ).rejects.toThrow('Invalid repository name derived from URL')

    expect(gitSpawnMock).not.toHaveBeenCalled()
  })

  it('accepts Windows local-path clone sources while validating the final segment', async () => {
    const destination = await createTempRoot()

    const result = await handlers.get('repos:clone')!(null, {
      url: 'C:\\src\\orca.git',
      destination
    })

    expect(gitSpawnMock).toHaveBeenCalledWith(
      ['clone', '--progress', '--', 'C:\\src\\orca.git', join(destination, 'orca')],
      expect.objectContaining({ cwd: destination })
    )
    expect(result).toHaveProperty('path', join(destination, 'orca'))
  })

  it('treats cloneAbort with no active clone as a no-op', async () => {
    await expect(handlers.get('repos:cloneAbort')!(null, undefined)).resolves.toBeUndefined()
  })

  it('does not remove an existing target directory when aborting a pending clone', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    await mkdir(clonePath)
    await writeFile(join(clonePath, 'user-file.txt'), 'keep me')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    proc.emit('close', null, 'SIGTERM')
    await expect(clonePromise).rejects.toThrow('Clone aborted')

    expect(existsSync(clonePath)).toBe(true)
    expect(existsSync(join(clonePath, 'user-file.txt'))).toBe(true)
  })

  it('does not remove an existing target file when aborting a pending clone', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    await writeFile(clonePath, 'existing file')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    proc.emit('close', null, 'SIGTERM')
    await expect(clonePromise).rejects.toThrow('Clone aborted')

    expect(existsSync(clonePath)).toBe(true)
  })

  it('removes a fresh clone target only after the aborted process closes unsuccessfully', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    expect(existsSync(clonePath)).toBe(true)

    proc.emit('close', null, 'SIGTERM')
    await expect(clonePromise).rejects.toThrow('Clone aborted')
    expect(existsSync(clonePath)).toBe(false)
  })

  it('removes an owned fresh clone target when git exits unsuccessfully', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const partialFile = join(clonePath, 'partial.txt')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))
    await writeFile(partialFile, 'git wrote this before failing')

    proc.stderr.emit('data', Buffer.from('fatal: repository not found\n'))
    proc.emit('close', 128, null)
    await expect(clonePromise).rejects.toThrow('Clone failed: fatal: repository not found')

    expect(existsSync(clonePath)).toBe(false)
  })

  it('reports the full fatal clone error when stderr includes progress fragments', async () => {
    const destination = await createTempRoot()
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    proc.stderr.emit(
      'data',
      Buffer.from(
        "Cloning into 'orca'...\rfatal: destination path 'orca' already exists and is not an empty directory.\r\nand the repository exists.\n"
      )
    )
    proc.emit('close', 128, null)

    await expect(clonePromise).rejects.toThrow(
      `Clone failed: Destination already exists and is not empty: ${join(
        destination,
        'orca'
      )}. Choose a different parent folder, delete the existing folder, or add the existing repository instead.`
    )
  })

  it('removes an owned fresh clone target when git spawn emits an error', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const partialFile = join(clonePath, 'partial.txt')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))
    await writeFile(partialFile, 'git wrote this before spawn failure')

    proc.emit('error', new Error('spawn failed'))
    await expect(clonePromise).rejects.toThrow('Clone failed: spawn failed')

    expect(existsSync(clonePath)).toBe(false)
  })

  it('keeps a fresh clone target when abort races with a successful close', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    proc.emit('close', 0, null)
    await expect(clonePromise).resolves.toMatchObject({
      path: clonePath,
      kind: 'git'
    })

    expect(existsSync(clonePath)).toBe(true)
  })

  it('dedupes retry when abort races with a successful clone close', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const repos: unknown[] = []
    mockStore.getRepos.mockImplementation(() => repos)
    mockStore.addRepo.mockImplementation((repo: unknown) => {
      repos.push(repo)
    })
    const firstProc = createMockCloneProcess()
    const secondProc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc)

    const firstClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    const secondClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(gitSpawnMock).toHaveBeenCalledTimes(1)

    firstProc.emit('close', 0, null)
    await expect(firstClonePromise).resolves.toMatchObject({ path: clonePath, kind: 'git' })
    await expect(secondClonePromise).resolves.toMatchObject({ path: clonePath, kind: 'git' })

    expect(gitSpawnMock).toHaveBeenCalledTimes(1)
    expect(secondProc.kill).not.toHaveBeenCalled()
  })

  it('serializes concurrent clones for the same target', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const repos: unknown[] = []
    mockStore.getRepos.mockImplementation(() => repos)
    mockStore.addRepo.mockImplementation((repo: unknown) => {
      repos.push(repo)
    })
    const firstProc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(firstProc)

    const firstClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    const secondClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    firstProc.emit('close', 0, null)
    await expect(firstClonePromise).resolves.toMatchObject({ path: clonePath, kind: 'git' })
    await expect(secondClonePromise).resolves.toMatchObject({ path: clonePath, kind: 'git' })

    expect(gitSpawnMock).toHaveBeenCalledTimes(1)
  })

  it('waits for pending abort cleanup before retrying the same clone target', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const partialFile = join(clonePath, 'partial.txt')
    const firstProc = createMockCloneProcess()
    const secondProc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc)

    const firstClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))
    await writeFile(partialFile, 'first clone wrote this before abort')
    await handlers.get('repos:cloneAbort')!(null, undefined)

    const secondClonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(gitSpawnMock).toHaveBeenCalledTimes(1)
    expect(existsSync(partialFile)).toBe(true)

    firstProc.emit('close', null, 'SIGTERM')
    await expect(firstClonePromise).rejects.toThrow('Clone aborted')
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(2))
    expect(existsSync(partialFile)).toBe(false)

    secondProc.emit('close', 0, null)
    await expect(secondClonePromise).resolves.toMatchObject({
      path: clonePath,
      kind: 'git'
    })
    expect(existsSync(clonePath)).toBe(true)
  })

  it('skips abort cleanup when the claimed target is replaced before close', async () => {
    const destination = await createTempRoot()
    const clonePath = join(destination, 'orca')
    const replacementFile = join(clonePath, 'replacement.txt')
    const proc = createMockCloneProcess()
    gitSpawnMock.mockReturnValueOnce(proc)

    const clonePromise = handlers.get('repos:clone')!(null, {
      url: 'https://example.com/orca.git',
      destination
    })
    await waitForAssertion(() => expect(gitSpawnMock).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)
    await rm(clonePath, { recursive: true, force: true })
    await mkdir(clonePath)
    await writeFile(replacementFile, 'new owner')

    proc.emit('close', null, 'SIGTERM')
    await expect(clonePromise).rejects.toThrow('Clone aborted')

    expect(existsSync(replacementFile)).toBe(true)
  })
})

describe('repos:getBaseRefDefault envelope', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.getRepo.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
    // Reset exec to default: later SSH tests replace this with custom mocks, and
    // without this reset any future test added to this block would inherit the
    // last test's exec mock — latent fragility we guard against here.
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('returns { defaultBaseRef, remoteCount: 0 } for folder-mode repos', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/some/folder',
      kind: 'folder'
    })

    const result = await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })

    expect(result).toEqual({ defaultBaseRef: null, remoteCount: 0 })
  })

  it('returns { defaultBaseRef: null, remoteCount: 0 } for an unknown repoId', async () => {
    mockStore.getRepo.mockReturnValue(undefined)

    const result = await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'missing' })

    expect(result).toEqual({ defaultBaseRef: null, remoteCount: 0 })
  })

  it('wraps the local getBaseRefDefault result in the envelope', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/repo',
      kind: 'git'
    })

    const result = (await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })) as {
      defaultBaseRef: string | null
      remoteCount: number
    }

    // getBaseRefDefault is mocked to 'origin/main', getRemoteCount to 1
    expect(result.defaultBaseRef).toBe('origin/main')
    expect(result.remoteCount).toBe(1)
  })

  // Why: the SSH handler resolves default-ref and remote-count in parallel
  // (Promise.all) so the order of calls into provider.exec is not stable.
  // Dispatch on argv instead of `mockResolvedValueOnce` chains so tests remain
  // independent of which Promise in the Promise.all resolves first.
  type ExecResponse = { stdout: string; stderr: string }
  type ExecRule = {
    match: (argv: string[]) => boolean
    respond: () => Promise<ExecResponse>
  }
  const dispatchExec = (rules: ExecRule[]): ((argv: string[]) => Promise<ExecResponse>) => {
    return (argv: string[]) => {
      for (const rule of rules) {
        if (rule.match(argv)) {
          return rule.respond()
        }
      }
      return Promise.reject(new Error(`unexpected exec call: ${argv.join(' ')}`))
    }
  }
  const isSymbolicRef = (argv: string[]): boolean =>
    argv[0] === 'symbolic-ref' && argv.includes('refs/remotes/origin/HEAD')
  const isRevParseFor =
    (ref: string) =>
    (argv: string[]): boolean =>
      argv[0] === 'rev-parse' && argv.includes(ref)
  const isRemoteList = (argv: string[]): boolean => argv.length === 1 && argv[0] === 'remote'

  it('returns envelope over SSH relay for remote repos', async () => {
    mockGitProvider.exec = vi.fn().mockImplementation(
      dispatchExec([
        {
          match: isSymbolicRef,
          respond: () => Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' })
        },
        {
          match: isRemoteList,
          respond: () => Promise.resolve({ stdout: 'origin\nupstream\n', stderr: '' })
        }
      ])
    )

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = (await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })) as {
      defaultBaseRef: string | null
      remoteCount: number
    }

    expect(result.defaultBaseRef).toBe('origin/main')
    expect(result.remoteCount).toBe(2)
  })

  it('returns defaultBaseRef even when remote-count lookup fails', async () => {
    mockGitProvider.exec = vi.fn().mockImplementation(
      dispatchExec([
        {
          match: isSymbolicRef,
          respond: () => Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' })
        },
        {
          match: isRemoteList,
          respond: () => Promise.reject(new Error('relay exec failed'))
        }
      ])
    )

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = (await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })) as {
      defaultBaseRef: string | null
      remoteCount: number
    }

    // Why: default detection must be independent of remote-count lookup.
    // A failing count falls back to 0, but the default still resolves.
    expect(result.defaultBaseRef).toBe('origin/main')
    expect(result.remoteCount).toBe(0)
  })

  it('falls back through probes over SSH when symbolic-ref fails', async () => {
    mockGitProvider.exec = vi.fn().mockImplementation(
      dispatchExec([
        // symbolic-ref rejects (no origin/HEAD on the remote)
        { match: isSymbolicRef, respond: () => Promise.reject(new Error('no symbolic-ref')) },
        // probe 1: refs/remotes/origin/main — rejects
        {
          match: isRevParseFor('refs/remotes/origin/main'),
          respond: () => Promise.reject(new Error('missing'))
        },
        // probe 2: refs/remotes/origin/master — succeeds
        {
          match: isRevParseFor('refs/remotes/origin/master'),
          respond: () => Promise.resolve({ stdout: 'abc123\n', stderr: '' })
        },
        { match: isRemoteList, respond: () => Promise.resolve({ stdout: 'origin\n', stderr: '' }) }
      ])
    )

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = (await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })) as {
      defaultBaseRef: string | null
      remoteCount: number
    }

    // Why: when symbolic-ref fails, the probe chain should find
    // refs/remotes/origin/master and return 'origin/master', matching
    // the local path's getDefaultBaseRefAsync behavior.
    expect(result.defaultBaseRef).toBe('origin/master')
    expect(result.remoteCount).toBe(1)
  })
})

describe('repos:searchBaseRefs SSH relay', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.getRepo.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('returns [] for a folder-mode repo without invoking the relay', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/some/folder',
      kind: 'folder',
      connectionId: 'conn-1'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'main'
    })

    expect(result).toEqual([])
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
  })

  it('returns refs for an empty query so remote Branch pickers open populated', async () => {
    const stdout = [
      'refs/remotes/origin/main\0origin/main',
      'refs/remotes/upstream/feature-x\0upstream/feature-x'
    ].join('\n')
    mockGitProvider.exec = vi.fn().mockImplementation((argv: string[]) => {
      if (argv[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\nupstream\n', stderr: '' })
      }
      return Promise.resolve({ stdout, stderr: '' })
    })
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: ''
    })

    expect(result).toEqual(['origin/main', 'upstream/feature-x'])
    expect(mockGitProvider.exec).toHaveBeenCalledTimes(2)
    const [argv] = mockGitProvider.exec.mock.calls.find(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )!
    expect(argv).toContain('--exclude=refs/remotes/**/HEAD')
    expect(argv).toContain('--count=100')
    expect(argv).toContain('refs/heads/**/**')
    expect(argv).toContain('refs/heads/**/**/**')
    expect(argv).toContain('refs/remotes/**/**')
    expect(argv).toContain('refs/remotes/**/**/**')
  })

  it('sanitizes glob metacharacter-only queries into the empty-query branch list', async () => {
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: '***'
    })

    // Why: normalizeRefSearchQuery still strips glob metacharacters before
    // building argv; the resulting empty query now intentionally lists refs.
    const [argv] = mockGitProvider.exec.mock.calls.find(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )!
    expect(argv).toContain('--exclude=refs/remotes/**/HEAD')
    expect(argv).toContain('--count=100')
    expect(argv).toContain('refs/heads/**/**')
    expect(argv).toContain('refs/heads/**/**/**')
    expect(argv).toContain('refs/remotes/**/**')
    expect(argv).toContain('refs/remotes/**/**/**')
  })

  it('rejects invalid limits before building broad relay searches', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: '',
      limit: 0.5
    })

    expect(result).toEqual([])
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
  })

  it('retries without --exclude for older git on SSH hosts', async () => {
    const stdout = [
      'refs/remotes/origin/main\0origin/main',
      'refs/remotes/origin/HEAD\0origin/HEAD'
    ].join('\n')
    mockGitProvider.exec = vi.fn().mockImplementation((argv: string[]) => {
      if (argv[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\n', stderr: '' })
      }
      if (argv.includes('--exclude=refs/remotes/**/HEAD')) {
        return Promise.reject(
          Object.assign(new Error("unknown option `exclude'"), {
            stderr: "error: unknown option `exclude'"
          })
        )
      }
      return Promise.resolve({ stdout, stderr: '' })
    })
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: '',
      limit: 1
    })

    expect(result).toEqual(['origin/main'])
    const forEachRefCalls = mockGitProvider.exec.mock.calls.filter(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )
    expect(forEachRefCalls).toHaveLength(2)
    expect(forEachRefCalls[0][0]).toContain('--exclude=refs/remotes/**/HEAD')
    expect(forEachRefCalls[1][0]).not.toContain('--exclude=refs/remotes/**/HEAD')
    expect(forEachRefCalls[1][0]).toContain('--count=104')
  })

  it('sends the widened `**` argv so all remotes and slash-named branches are discoverable', async () => {
    // Why: this is the core issue-624 behavior — the SSH path must glob all
    // remotes, not just origin. The `**` globs additionally span ref segments
    // so slash-named branches (`user/feature`) are found by a single-word
    // query; a single `*` would not cross `/`.
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    await handlers.get('repos:searchBaseRefs')!(null, { repoId: 'r1', query: 'upstream' })

    expect(mockGitProvider.exec).toHaveBeenCalledTimes(2)
    const [argv, path] = mockGitProvider.exec.mock.calls.find(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )!
    expect(path).toBe('/remote/repo')
    expect(argv[0]).toBe('for-each-ref')
    expect(argv).toContain('refs/heads/**/*upstream*')
    expect(argv).toContain('refs/heads/**/*upstream*/**')
    expect(argv).toContain('refs/remotes/**/*upstream*')
    expect(argv).toContain('refs/remotes/**/*upstream*/**')
    // Guard against regression to the old origin-only glob.
    expect(argv).not.toContain('refs/remotes/origin/*upstream*')
    expect(mockGitProvider.exec).toHaveBeenCalledWith(['remote'], '/remote/repo')
  })

  it('sends segmented argv for display-format queries like `upstream/main`', async () => {
    // Why: guards against the SSH path drifting from the local path for
    // multi-segment queries. The picker shows results as `<remote>/<branch>`
    // and users retype that format; if the SSH argv reverts to a single
    // `*<q>*` glob containing the literal `/`, SSH users silently see no
    // matches for valid refs — the same shape of bug as issue #624.
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    await handlers.get('repos:searchBaseRefs')!(null, { repoId: 'r1', query: 'upstream/main' })

    expect(mockGitProvider.exec).toHaveBeenCalledTimes(2)
    const [argv] = mockGitProvider.exec.mock.calls.find(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )!
    expect(argv).toContain('refs/remotes/*upstream*/*main*')
    expect(argv).toContain('refs/heads/*upstream*/*main*')
    // Regression guard: the literal slash must never appear inside a
    // single segmented glob (would be `refs/remotes/*upstream/main*`),
    // which fnmatch cannot match because `*` doesn't cross `/`.
    expect(argv).not.toContain('refs/remotes/*upstream/main*/*')
    expect(argv).not.toContain('refs/remotes/*/*upstream/main*')
    expect(mockGitProvider.exec).toHaveBeenCalledWith(['remote'], '/remote/repo')
  })

  it('parses NUL-delimited stdout and filters <remote>/HEAD pseudo-refs', async () => {
    // Why: exercises the shared parseAndFilterSearchRefs pipeline end-to-end
    // on the SSH path — confirms the HEAD filter works for any remote (not
    // just origin) when results come from the relay.
    const stdout = [
      'refs/remotes/origin/main\0origin/main',
      'refs/remotes/upstream/main\0upstream/main',
      'refs/remotes/upstream/HEAD\0upstream/HEAD',
      'refs/remotes/origin/HEAD\0origin/HEAD'
    ].join('\n')
    mockGitProvider.exec = vi.fn().mockResolvedValue({ stdout, stderr: '' })

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = (await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'main'
    })) as string[]

    expect(result).toEqual(['origin/main', 'upstream/main'])
    expect(result).not.toContain('origin/HEAD')
    expect(result).not.toContain('upstream/HEAD')
  })

  it('returns [] when the relay exec throws', async () => {
    mockGitProvider.exec = vi.fn().mockRejectedValue(new Error('ssh connection dropped'))

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'main'
    })

    // Why: transport failure must fall back to an empty result set — mirrors
    // the local path's catch, so SSH users see "no matches" instead of a
    // crashed picker when the relay drops.
    expect(result).toEqual([])
  })

  it('returns [] when the SSH provider is not connected', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'unknown-conn',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'main'
    })

    expect(result).toEqual([])
  })
})
