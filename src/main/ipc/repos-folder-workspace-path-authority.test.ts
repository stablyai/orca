import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSshFilesystemProviderMock, handleMock } = vi.hoisted(() => ({
  getSshFilesystemProviderMock: vi.fn(),
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: handleMock, removeHandler: vi.fn() }
}))

vi.mock('../git/runner', () => ({ gitExecFileAsync: vi.fn(), gitSpawn: vi.fn() }))
vi.mock('../git/repo', () => ({
  getBaseRefDefault: vi.fn(),
  getRepoName: vi.fn(),
  isGitRepo: vi.fn(),
  searchBaseRefs: vi.fn()
}))
vi.mock('./filesystem-auth', () => ({ invalidateAuthorizedRootsCache: vi.fn() }))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: vi.fn() }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))
vi.mock('./ssh', () => ({ getActiveMultiplexer: vi.fn() }))
vi.mock('./worktree-base-directory-watcher', () => ({
  scheduleCurrentWorktreeBaseDirectoryWatcherSync: vi.fn()
}))

import { registerRepoHandlers } from './repos'

type Handler = (event: unknown, args: unknown) => unknown

const handlers = new Map<string, Handler>()
const mainWindow = {
  isDestroyed: () => false,
  webContents: { send: vi.fn() }
}
const group = {
  id: 'ssh-group',
  parentPath: process.cwd(),
  connectionId: 'ssh-owner' as string | null
}
const workspace = {
  id: 'local-workspace',
  projectGroupId: group.id,
  folderPath: process.cwd(),
  connectionId: null as string | null | undefined
}
const store = {
  createFolderWorkspace: vi.fn(() => workspace),
  getFolderWorkspace: vi.fn(() => workspace),
  getFolderWorkspaces: vi.fn(() => [workspace]),
  getProjectGroups: vi.fn(() => [group]),
  getRepos: vi.fn(() => [
    {
      id: 'ssh-repo',
      path: process.cwd(),
      projectGroupId: group.id,
      connectionId: 'ssh-owner'
    }
  ]),
  updateFolderWorkspace: vi.fn(() => workspace),
  updateProjectGroup: vi.fn(() => group)
}

beforeEach(() => {
  handlers.clear()
  handleMock.mockReset()
  handleMock.mockImplementation((channel: string, handler: Handler) => {
    handlers.set(channel, handler)
  })
  getSshFilesystemProviderMock.mockReset()
  store.createFolderWorkspace.mockClear()
  store.getFolderWorkspace.mockReset()
  store.getFolderWorkspace.mockReturnValue(workspace)
  store.getFolderWorkspaces.mockReset()
  store.getFolderWorkspaces.mockReturnValue([workspace])
  store.getProjectGroups.mockReset()
  store.getProjectGroups.mockReturnValue([group])
  store.updateFolderWorkspace.mockClear()
  store.updateProjectGroup.mockClear()
  registerRepoHandlers(mainWindow as never, store as never)
})

describe('folder workspace IPC path ownership', () => {
  it('forwards path-status ownership through the IPC schema', async () => {
    const localGroup = { ...group, connectionId: null }
    const sshGroup = { ...group, parentPath: '/srv/ssh' }
    const localWorkspace = { ...workspace, id: 'shared-folder', connectionId: null }
    const sshWorkspace = {
      ...workspace,
      id: 'shared-folder',
      folderPath: '/srv/ssh',
      connectionId: 'ssh-owner'
    }
    const stat = vi.fn(async () => ({ type: 'directory' }))
    store.getProjectGroups.mockReturnValue([localGroup, sshGroup])
    store.getFolderWorkspaces.mockReturnValue([localWorkspace, sshWorkspace])
    getSshFilesystemProviderMock.mockReturnValue({ stat })

    await expect(
      handlers.get('folderWorkspaces:getPathStatus')!(null, {
        scope: 'folder-workspace',
        folderWorkspaceId: 'shared-folder',
        executionHostId: 'ssh:ssh-owner'
      })
    ).resolves.toEqual({ path: '/srv/ssh', exists: true })
    expect(stat).toHaveBeenCalledWith('/srv/ssh')
  })

  it('validates creation against the connection-owned group in either catalog order', async () => {
    const localGroup = { ...group, parentPath: '/workspace/local', connectionId: null }
    const sshGroup = { ...group, parentPath: '/srv/ssh' }
    const stat = vi.fn(async () => ({ type: 'directory' }))
    getSshFilesystemProviderMock.mockReturnValue({ stat })

    for (const groups of [
      [localGroup, sshGroup],
      [sshGroup, localGroup]
    ]) {
      store.getProjectGroups.mockReturnValue(groups)

      await expect(
        handlers.get('folderWorkspaces:create')!(null, {
          projectGroupId: group.id,
          connectionId: 'ssh-owner'
        })
      ).resolves.toBe(workspace)
      expect(stat).toHaveBeenLastCalledWith('/srv/ssh')
    }
  })

  it('validates an explicit-null create against the local filesystem', async () => {
    store.getProjectGroups.mockReturnValue([{ ...group, connectionId: null }])

    await expect(
      handlers.get('folderWorkspaces:create')!(null, {
        projectGroupId: group.id,
        folderPath: process.cwd(),
        connectionId: null
      })
    ).resolves.toBe(workspace)

    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
    expect(store.createFolderWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: null })
    )
  })

  it('validates an explicit-null workspace update against the local filesystem', async () => {
    store.getProjectGroups.mockReturnValue([{ ...group, connectionId: null }])

    await expect(
      handlers.get('folderWorkspaces:update')!(null, {
        folderWorkspaceId: workspace.id,
        executionHostId: 'local',
        updates: { folderPath: process.cwd() }
      })
    ).resolves.toBe(workspace)

    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
    expect(store.updateFolderWorkspace).toHaveBeenCalledWith(
      workspace.id,
      { folderPath: process.cwd() },
      { executionHostId: 'local' }
    )
  })

  it('validates updates against the workspace-owned group in either catalog order', async () => {
    const localGroup = { ...group, parentPath: '/workspace/local', connectionId: null }
    const sshGroup = { ...group, parentPath: '/srv/ssh' }
    const remoteWorkspace = {
      ...workspace,
      connectionId: undefined,
      executionHostId: 'ssh:ssh-owner' as const
    }
    const stat = vi.fn(async () => ({ type: 'directory' }))
    store.getFolderWorkspace.mockReturnValue(remoteWorkspace)
    getSshFilesystemProviderMock.mockReturnValue({ stat })

    for (const groups of [
      [localGroup, sshGroup],
      [sshGroup, localGroup]
    ]) {
      store.getProjectGroups.mockReturnValue(groups)

      await expect(
        handlers.get('folderWorkspaces:update')!(null, {
          folderWorkspaceId: workspace.id,
          executionHostId: 'ssh:ssh-owner',
          updates: { folderPath: '/srv/ssh/updated' }
        })
      ).resolves.toBe(workspace)
      expect(stat).toHaveBeenLastCalledWith('/srv/ssh/updated')
    }
  })

  it('forwards a host-qualified project-group update to persistence', () => {
    expect(
      handlers.get('projectGroups:update')!(null, {
        groupId: group.id,
        executionHostId: 'ssh:ssh-owner',
        updates: { name: 'Renamed' }
      })
    ).toBe(group)

    expect(store.updateProjectGroup).toHaveBeenCalledWith(
      group.id,
      { name: 'Renamed' },
      { executionHostId: 'ssh:ssh-owner' }
    )
  })
})
