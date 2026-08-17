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

const {
  handleMock,
  mockStore,
  mockGitProvider,
  mockFilesystemProvider,
  mockMultiplexer,
  listWorktreeGraphMock
} = reposMocks

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

  it('resolves SSH linked worktree imports through the SSH provider worktree graph', async () => {
    const selectedPath = '/srv/platform/demo/brash-binder'
    const secondSelectedPath = '/srv/platform/demo/quick-howler'
    const mainPath = '/srv/source/demo-project'
    mockGitProvider.isGitRepoAsync.mockImplementation(async (path: string) => ({
      isRepo: path === selectedPath || path === secondSelectedPath,
      rootPath: '/srv/provider/root'
    }))
    mockGitProvider.listWorktrees.mockResolvedValue([
      {
        path: mainPath,
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: selectedPath,
        head: 'feature-head',
        branch: 'refs/heads/brash-binder',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: secondSelectedPath,
        head: 'feature-head',
        branch: 'refs/heads/quick-howler',
        isBare: false,
        isMainWorktree: false
      }
    ])
    mockFilesystemProvider.stat.mockImplementation(async (path: string) => {
      if (path === `${selectedPath}/.git` || path === `${secondSelectedPath}/.git`) {
        return { type: 'directory', size: 0, mtime: 0 }
      }
      throw new Error('not found')
    })
    mockFilesystemProvider.readDir.mockImplementation(async (dirPath: string) =>
      dirPath === '/srv/platform/demo'
        ? [
            { name: 'brash-binder', isDirectory: true, isSymlink: false },
            { name: 'quick-howler', isDirectory: true, isSymlink: false }
          ]
        : []
    )

    const result = await handlers.get('projectGroups:importNested')!(null, {
      parentPath: '/srv/platform/demo',
      groupName: '',
      projectPaths: [selectedPath, secondSelectedPath],
      connectionId: 'conn-1',
      mode: 'separate'
    })

    expect(result).toMatchObject({ importedCount: 1, alreadyKnownCount: 1, failedCount: 0 })
    expect(mockGitProvider.listWorktrees).toHaveBeenCalledWith(selectedPath)
    expect(mockGitProvider.listWorktrees).toHaveBeenCalledTimes(1)
    expect(listWorktreeGraphMock).not.toHaveBeenCalled()
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: mainPath,
        connectionId: 'conn-1'
      })
    )
    expect(mockMultiplexer.notify).toHaveBeenCalledWith('session.registerRoot', {
      rootPath: mainPath
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

  it('imports selected local linked worktrees as one project rooted at the main worktree', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-nested-linked-worktrees-'))
    try {
      const parentPath = join(tempRoot, 'paseo-worktrees', 'demo-project')
      const mainPath = join(tempRoot, 'source', 'demo-project')
      const firstWorktreePath = join(parentPath, 'brash-binder')
      const secondWorktreePath = join(parentPath, 'quick-howler')
      await mkdir(join(firstWorktreePath, '.git'), { recursive: true })
      await mkdir(join(secondWorktreePath, '.git'), { recursive: true })
      await mkdir(mainPath, { recursive: true })
      vi.mocked(isGitRepo).mockReturnValue(false)
      vi.mocked(isGitRepo).mockImplementation((path: string) =>
        [firstWorktreePath, secondWorktreePath, mainPath].includes(path)
      )
      listWorktreeGraphMock.mockResolvedValue([
        {
          path: mainPath,
          head: 'main-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: firstWorktreePath,
          head: 'feature-head',
          branch: 'refs/heads/brash-binder',
          isBare: false,
          isMainWorktree: false
        },
        {
          path: secondWorktreePath,
          head: 'feature-head',
          branch: 'refs/heads/quick-howler',
          isBare: false,
          isMainWorktree: false
        }
      ])

      const result = await handlers.get('projectGroups:importNested')!(null, {
        parentPath,
        groupName: '',
        projectPaths: [firstWorktreePath, secondWorktreePath],
        mode: 'separate'
      })

      expect(result).toMatchObject({
        importedCount: 1,
        alreadyKnownCount: 1,
        failedCount: 0
      })
      expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
      expect(mockStore.addRepo).toHaveBeenCalledWith(expect.objectContaining({ path: mainPath }))
      expect(listWorktreeGraphMock).toHaveBeenCalledTimes(1)
      expect((result as { projects: { projectId?: string }[] }).projects[0].projectId).toBe(
        (result as { projects: { projectId?: string }[] }).projects[1].projectId
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
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
