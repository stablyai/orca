import { describe, expect, it, vi, beforeEach } from 'vitest'

const { handleMock, mockStore, mockGitProvider } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mockStore: {
    getRepos: vi.fn().mockReturnValue([]),
    addRepo: vi.fn(),
    removeRepo: vi.fn(),
    getRepo: vi.fn(),
    updateRepo: vi.fn()
  },
  mockGitProvider: {
    isGitRepo: vi.fn().mockReturnValue(true),
    isGitRepoAsync: vi.fn().mockResolvedValue({ isRepo: true, rootPath: null }),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
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
  // Why: getBaseRefDefault's signature is unchanged — it still returns
  // `string | null`. The IPC handler is what wraps the result into the
  // `BaseRefDefaultResult` envelope, so this mock stays as a string.
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  getRemoteCount: vi.fn().mockResolvedValue(1),
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

  it('returns envelope over SSH relay for remote repos', async () => {
    const execMock = vi
      .fn()
      // symbolic-ref call
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main\n', stderr: '' })
      // remote count call
      .mockResolvedValueOnce({ stdout: 'origin\nupstream\n', stderr: '' })

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })
    // Replace provider with one that exposes exec()
    mockGitProvider.exec = execMock

    const result = (await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })) as {
      defaultBaseRef: string | null
      remoteCount: number
    }

    expect(result.defaultBaseRef).toBe('origin/main')
    expect(result.remoteCount).toBe(2)
  })

  it('returns defaultBaseRef even when remote-count lookup fails', async () => {
    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main\n', stderr: '' })
      .mockRejectedValueOnce(new Error('relay exec failed'))

    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })
    mockGitProvider.exec = execMock

    const result = (await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })) as {
      defaultBaseRef: string | null
      remoteCount: number
    }

    // Why: default detection must be independent of remote-count lookup.
    // A failing count falls back to 0, but the default still resolves.
    expect(result.defaultBaseRef).toBe('origin/main')
    expect(result.remoteCount).toBe(0)
  })
})
