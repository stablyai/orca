import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  handleMock,
  mkdirMock,
  rmMock,
  gitExecFileAsyncMock,
  rebuildAuthorizedRootsCacheMock,
  mockStore
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mkdirMock: vi.fn(),
  rmMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  rebuildAuthorizedRootsCacheMock: vi.fn(),
  mockStore: {
    getRepos: vi.fn().mockReturnValue([]),
    addRepo: vi.fn(),
    removeRepo: vi.fn(),
    getRepo: vi.fn(),
    updateRepo: vi.fn()
  }
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: handleMock,
    removeHandler: vi.fn()
  }
}))

vi.mock('fs/promises', () => ({
  mkdir: mkdirMock,
  rm: rmMock
}))

vi.mock('../git/runner', () => ({
  gitSpawn: vi.fn(),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../git/repo', () => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getGitUsername: vi.fn().mockReturnValue(''),
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  searchBaseRefs: vi.fn().mockResolvedValue([])
}))

vi.mock('./filesystem-auth', () => ({
  rebuildAuthorizedRootsCache: rebuildAuthorizedRootsCacheMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn().mockReturnValue(undefined)
}))

import { registerRepoHandlers } from './repos'

describe('repos:createLocal', () => {
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

    mkdirMock.mockReset().mockResolvedValue(undefined)
    rmMock.mockReset().mockResolvedValue(undefined)
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
    rebuildAuthorizedRootsCacheMock.mockReset().mockResolvedValue(undefined)

    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.addRepo.mockReset()
    mockWindow.webContents.send.mockReset()

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('registers the repos:createLocal handler', () => {
    expect(handlers.has('repos:createLocal')).toBe(true)
  })

  it('creates a local git repository', async () => {
    const result = await handlers.get('repos:createLocal')!(null, {
      parentPath: '/tmp/projects',
      name: 'orca-new',
      kind: 'git'
    })

    expect(mkdirMock).toHaveBeenCalledWith('/tmp/projects/orca-new', { recursive: false })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['init', 'orca-new'], {
      cwd: '/tmp/projects'
    })
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/tmp/projects/orca-new',
        displayName: 'orca-new',
        kind: 'git'
      })
    )
    expect(rebuildAuthorizedRootsCacheMock).toHaveBeenCalled()
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
    expect(result).toHaveProperty('repo.kind', 'git')
  })

  it('creates a local folder without initializing git', async () => {
    const result = await handlers.get('repos:createLocal')!(null, {
      parentPath: '/tmp/projects',
      name: 'notes',
      kind: 'folder'
    })

    expect(mkdirMock).toHaveBeenCalledWith('/tmp/projects/notes', { recursive: false })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/tmp/projects/notes',
        kind: 'folder'
      })
    )
    expect(result).toHaveProperty('repo.kind', 'folder')
  })

  it('rejects invalid folder names that contain path separators', async () => {
    const result = await handlers.get('repos:createLocal')!(null, {
      parentPath: '/tmp/projects',
      name: 'nested/project',
      kind: 'git'
    })

    expect(result).toEqual({ error: 'Name must be a single folder name' })
    expect(mkdirMock).not.toHaveBeenCalled()
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('cleans up the created folder when git init fails', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('git not found'))

    const result = await handlers.get('repos:createLocal')!(null, {
      parentPath: '/tmp/projects',
      name: 'broken-repo',
      kind: 'git'
    })

    expect(rmMock).toHaveBeenCalledWith('/tmp/projects/broken-repo', {
      recursive: true,
      force: true
    })
    expect(result).toEqual({
      error: 'Failed to initialize git repository: git not found'
    })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })
})
