import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  removeHandlerMock,
  listWorktreesMock,
  addWorktreeMock,
  removeWorktreeMock,
  getGitUsernameMock,
  getDefaultBaseRefMock,
  getBranchConflictKindMock,
  getPRForBranchMock,
  getEffectiveHooksMock,
  createIssueCommandRunnerScriptMock,
  createSetupRunnerScriptMock,
  shouldRunSetupForCreateMock,
  runHookMock,
  hasHooksFileMock,
  loadHooksMock,
  setupScriptsMatchMock,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  addWorktreeMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  getGitUsernameMock: vi.fn(),
  getDefaultBaseRefMock: vi.fn(),
  getBranchConflictKindMock: vi.fn(),
  getPRForBranchMock: vi.fn(),
  getEffectiveHooksMock: vi.fn(),
  createIssueCommandRunnerScriptMock: vi.fn(),
  createSetupRunnerScriptMock: vi.fn(),
  shouldRunSetupForCreateMock: vi.fn(),
  setupScriptsMatchMock: vi.fn(() => true),
  runHookMock: vi.fn(),
  hasHooksFileMock: vi.fn(),
  loadHooksMock: vi.fn(),
  computeWorktreePathMock: vi.fn(),
  ensurePathWithinWorkspaceMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: listWorktreesMock,
  addWorktree: addWorktreeMock,
  removeWorktree: removeWorktreeMock
}))

vi.mock('../git/runner', () => ({
  // Why: createLocalWorktree now fires `git fetch` via gitExecFileAsync in the
  // background. Return a resolved promise so the fire-and-forget `.catch()`
  // chain has a valid Promise to attach to.
  gitExecFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  gitExecFileSync: vi.fn()
}))

vi.mock('../git/repo', () => ({
  getGitUsername: getGitUsernameMock,
  getDefaultBaseRef: getDefaultBaseRefMock,
  getBranchConflictKind: getBranchConflictKindMock
}))

vi.mock('../github/client', () => ({
  getPRForBranch: getPRForBranchMock
}))

vi.mock('../hooks', () => ({
  createIssueCommandRunnerScript: createIssueCommandRunnerScriptMock,
  createSetupRunnerScript: createSetupRunnerScriptMock,
  getEffectiveHooks: getEffectiveHooksMock,
  loadHooks: loadHooksMock,
  runHook: runHookMock,
  hasHooksFile: hasHooksFileMock,
  shouldRunSetupForCreate: shouldRunSetupForCreateMock,
  setupScriptsMatch: setupScriptsMatchMock
}))

vi.mock('./worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    computeWorktreePath: computeWorktreePathMock,
    ensurePathWithinWorkspace: ensurePathWithinWorkspaceMock
  }
})

import { registerWorktreeHandlers } from './worktrees'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerWorktreeHandlers – Windows path handling', () => {
  const handlers: HandlerMap = {}
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn()
    }
  }
  const store = {
    getRepos: vi.fn(),
    getRepo: vi.fn(),
    getSettings: vi.fn(),
    getWorktreeMeta: vi.fn(),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn()
  }

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    listWorktreesMock.mockReset()
    addWorktreeMock.mockReset()
    removeWorktreeMock.mockReset()
    getGitUsernameMock.mockReset()
    getDefaultBaseRefMock.mockReset()
    getBranchConflictKindMock.mockReset()
    getPRForBranchMock.mockReset()
    getEffectiveHooksMock.mockReset()
    createIssueCommandRunnerScriptMock.mockReset()
    createSetupRunnerScriptMock.mockReset()
    shouldRunSetupForCreateMock.mockReset()
    runHookMock.mockReset()
    hasHooksFileMock.mockReset()
    loadHooksMock.mockReset()
    computeWorktreePathMock.mockReset()
    ensurePathWithinWorkspaceMock.mockReset()
    mainWindow.webContents.send.mockReset()
    store.getRepos.mockReset()
    store.getRepo.mockReset()
    store.getSettings.mockReset()
    store.getWorktreeMeta.mockReset()
    store.setWorktreeMeta.mockReset()
    store.removeWorktreeMeta.mockReset()

    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })

    store.getRepos.mockReturnValue([
      {
        id: 'repo-1',
        path: 'C:\\repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0
      }
    ])
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: 'C:\\repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    })
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: 'C:\\workspaces'
    })
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.setWorktreeMeta.mockReturnValue({})
    getGitUsernameMock.mockReturnValue('')
    getDefaultBaseRefMock.mockReturnValue('origin/main')
    getBranchConflictKindMock.mockResolvedValue(null)
    getPRForBranchMock.mockResolvedValue(null)
    getEffectiveHooksMock.mockReturnValue(null)
    shouldRunSetupForCreateMock.mockReturnValue(false)
    computeWorktreePathMock.mockReturnValue('C:\\workspaces\\improve-dashboard')
    ensurePathWithinWorkspaceMock.mockReturnValue('C:\\workspaces\\improve-dashboard')
    listWorktreesMock.mockResolvedValue([])

    registerWorktreeHandlers(mainWindow as never, store as never)
  })

  it('accepts a newly created Windows worktree when git lists the same path with different separators', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: 'C:/workspaces/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      'C:\\repo',
      'C:\\workspaces\\improve-dashboard',
      'improve-dashboard',
      'origin/main',
      false
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::C:/workspaces/improve-dashboard',
      expect.objectContaining({
        lastActivityAt: expect.any(Number)
      })
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        id: 'repo-1::C:/workspaces/improve-dashboard',
        path: 'C:/workspaces/improve-dashboard',
        branch: 'refs/heads/improve-dashboard'
      })
    })
  })

  it('preserves create-time metadata on the next list when Windows path formatting differs', async () => {
    const worktreeEntry = {
      path: 'C:/workspaces/improve-dashboard',
      head: 'abc123',
      branch: 'refs/heads/improve-dashboard',
      isBare: false,
      isMainWorktree: false
    }
    // Three calls: (1) worktrees:create finds the new worktree,
    // (2) rebuildAuthorizedRootsCache enumerates worktrees for the repo,
    // (3) worktrees:list enumerates worktrees again.
    listWorktreesMock
      .mockResolvedValueOnce([worktreeEntry])
      .mockResolvedValueOnce([worktreeEntry])
      .mockResolvedValueOnce([worktreeEntry])
    store.setWorktreeMeta.mockReturnValue({
      lastActivityAt: 123,
      displayName: 'Improve Dashboard'
    })
    store.getWorktreeMeta.mockImplementation((worktreeId: string) =>
      worktreeId === 'repo-1::C:/workspaces/improve-dashboard'
        ? {
            lastActivityAt: 123,
            displayName: 'Improve Dashboard'
          }
        : undefined
    )

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'Improve Dashboard'
    })
    const listed = await handlers['worktrees:list'](null, {
      repoId: 'repo-1'
    })

    expect(listed).toMatchObject([
      {
        id: 'repo-1::C:/workspaces/improve-dashboard',
        displayName: 'Improve Dashboard',
        lastActivityAt: 123
      }
    ])
  })
})
