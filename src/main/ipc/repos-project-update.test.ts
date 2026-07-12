/**
 * Task 3 (WSL native project support): `ProjectUpdateIpcArgs` must carry
 * `defaultShell` through to `store.updateProject`, matching the existing
 * `localWindowsRuntimePreference` carve-out — otherwise zod silently strips
 * the field before it reaches the store.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Project } from '../../shared/types'

const { handleMock, mockStore } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mockStore: {
    getRepos: vi.fn().mockReturnValue([]),
    addRepo: vi.fn(),
    removeProject: vi.fn(),
    getRepo: vi.fn(),
    updateRepo: vi.fn(),
    updateProject: vi.fn()
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
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  searchBaseRefs: vi.fn().mockResolvedValue([]),
  BASE_REF_SEARCH_ARGS: ['for-each-ref'],
  filterBaseRefSearchOutput: vi.fn().mockReturnValue([])
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

type HandlerMap = Map<string, (_event: unknown, args: unknown) => unknown>

describe('projects:update IPC handler', () => {
  const handlers: HandlerMap = new Map()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    mockStore.updateProject.mockReset()
    registerRepoHandlers(mainWindow as never, mockStore as never)
  })

  it('forwards defaultShell to store.updateProject instead of stripping it', () => {
    mockStore.updateProject.mockReturnValue({
      id: 'project-1',
      defaultShell: 'powershell'
    } as Project)

    handlers.get('projects:update')!(null, {
      projectId: 'project-1',
      updates: { defaultShell: 'powershell' }
    })

    expect(mockStore.updateProject).toHaveBeenCalledWith('project-1', {
      defaultShell: 'powershell'
    })
  })
})
