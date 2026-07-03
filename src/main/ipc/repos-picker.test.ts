import { join, sep } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock, showOpenDialogMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  showOpenDialogMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: showOpenDialogMock },
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(),
  gitSpawn: vi.fn()
}))

vi.mock('../git/repo', () => ({
  isGitRepo: vi.fn(),
  getGitUsername: vi.fn(),
  getRepoName: vi.fn(),
  getBaseRefDefault: vi.fn(),
  searchBaseRefs: vi.fn()
}))

vi.mock('./filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: vi.fn()
}))

import { registerRepoHandlers } from './repos'

describe('repos folder pickers', () => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
  const mockStore = {
    getRepos: vi.fn().mockReturnValue([]),
    addRepo: vi.fn(),
    removeProject: vi.fn(),
    getRepo: vi.fn(),
    updateRepo: vi.fn()
  }

  const callPickFolders = (): Promise<string[]> => {
    const handler = handlers.get('repos:pickFolders')
    if (!handler) {
      throw new Error('repos:pickFolders handler was never registered')
    }
    return handler(null, undefined) as Promise<string[]>
  }

  const callPickDirectory = (): Promise<string | null> => {
    const handler = handlers.get('repos:pickDirectory')
    if (!handler) {
      throw new Error('repos:pickDirectory handler was never registered')
    }
    return handler(null, undefined) as Promise<string | null>
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler as (event: unknown, args: unknown) => unknown)
    })
    removeHandlerMock.mockReset()
    showOpenDialogMock.mockReset()

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('registers the multi-folder picker with handler cleanup', () => {
    expect(handlers.has('repos:pickFolders')).toBe(true)
    expect(removeHandlerMock).toHaveBeenCalledWith('repos:pickFolders')
  })

  it('picks multiple folders for the add-project browse flow', async () => {
    const projectA = join(sep, 'projects', 'a')
    const projectB = join(sep, 'projects', 'b')
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: [projectA, projectB]
    })

    await expect(callPickFolders()).resolves.toEqual([projectA, projectB])

    expect(showOpenDialogMock).toHaveBeenCalledWith(mockWindow, {
      properties: ['openDirectory', 'multiSelections']
    })
  })

  it('returns an empty folder list when multi-folder picking is canceled', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })

    await expect(callPickFolders()).resolves.toEqual([])
  })

  it('picks an existing directory without enabling native directory creation', async () => {
    const parentDir = join(sep, 'projects')
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: [parentDir]
    })

    await expect(callPickDirectory()).resolves.toBe(parentDir)

    expect(showOpenDialogMock).toHaveBeenCalledWith(mockWindow, {
      properties: ['openDirectory']
    })
  })
})
