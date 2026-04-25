import { describe, expect, it, vi, beforeEach } from 'vitest'

const { handleMock, mockStore, mockGitProvider, mockMultiplexer } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mockStore: {
    getRepos: vi.fn().mockReturnValue([]),
    addRepo: vi.fn(),
    removeRepo: vi.fn(),
    getRepo: vi.fn(),
    updateRepo: vi.fn(),
    getSshTarget: vi.fn()
  },
  mockGitProvider: {
    isGitRepo: vi.fn().mockReturnValue(true),
    isGitRepoAsync: vi.fn().mockResolvedValue({ isRepo: true, rootPath: null })
  },
  mockMultiplexer: {
    request: vi.fn(),
    notify: vi.fn()
  }
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: handleMock,
    removeHandler: vi.fn()
  }
}))

vi.mock('../git/repo', () => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getGitUsername: vi.fn().mockReturnValue(''),
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  searchBaseRefs: vi.fn().mockResolvedValue([])
}))

vi.mock('./filesystem-auth', () => ({
  rebuildAuthorizedRootsCache: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn().mockImplementation((id: string) => {
    if (id === 'conn-1') {
      return mockGitProvider
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
    mockMultiplexer.request.mockReset()
    mockMultiplexer.notify.mockReset()
    mockWindow.webContents.send.mockReset()

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('registers the repos:addRemote handler', () => {
    expect(handlers.has('repos:addRemote')).toBe(true)
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
        displayName: 'project'
      })
    )
    expect(result).toHaveProperty('repo.id')
    expect(result).toHaveProperty('repo.connectionId', 'conn-1')
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
        path: '/home/user/documents'
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
