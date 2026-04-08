/* eslint-disable max-lines */
import { mkdtemp, writeFile as fsWriteFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join as pathJoin } from 'path'
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
  createSetupRunnerScriptMock,
  shouldRunSetupForCreateMock,
  runHookMock,
  hasHooksFileMock,
  loadHooksMock,
  computeWorktreePathMock
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
  createSetupRunnerScriptMock: vi.fn(),
  shouldRunSetupForCreateMock: vi.fn(),
  runHookMock: vi.fn(),
  hasHooksFileMock: vi.fn(),
  loadHooksMock: vi.fn(),
  computeWorktreePathMock: vi.fn()
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

vi.mock('../git/repo', () => ({
  getGitUsername: getGitUsernameMock,
  getDefaultBaseRef: getDefaultBaseRefMock,
  getBranchConflictKind: getBranchConflictKindMock,
  isBareRepo: vi.fn().mockReturnValue(false)
}))

vi.mock('../github/client', () => ({
  getPRForBranch: getPRForBranchMock
}))

vi.mock('../hooks', () => ({
  createSetupRunnerScript: createSetupRunnerScriptMock,
  getEffectiveHooks: getEffectiveHooksMock,
  loadHooks: loadHooksMock,
  runHook: runHookMock,
  hasHooksFile: hasHooksFileMock,
  shouldRunSetupForCreate: shouldRunSetupForCreateMock
}))

vi.mock('./worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    computeWorktreePath: computeWorktreePathMock
  }
})

import { registerWorktreeHandlers } from './worktrees'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerWorktreeHandlers', () => {
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
    for (const m of [
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
      createSetupRunnerScriptMock,
      shouldRunSetupForCreateMock,
      runHookMock,
      hasHooksFileMock,
      loadHooksMock,
      computeWorktreePathMock,
      mainWindow.webContents.send,
      store.getRepos,
      store.getRepo,
      store.getSettings,
      store.getWorktreeMeta,
      store.setWorktreeMeta,
      store.removeWorktreeMeta
    ]) {
      m.mockReset()
    }

    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })

    const repo = {
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue({ ...repo, worktreeBaseRef: null })
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      workspaceDir: '/workspace',
      worktreeLocation: 'external'
    })
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.setWorktreeMeta.mockReturnValue({})
    getGitUsernameMock.mockReturnValue('')
    getDefaultBaseRefMock.mockReturnValue('origin/main')
    getBranchConflictKindMock.mockResolvedValue(null)
    getPRForBranchMock.mockResolvedValue(null)
    getEffectiveHooksMock.mockReturnValue(null)
    shouldRunSetupForCreateMock.mockReturnValue(false)
    createSetupRunnerScriptMock.mockReturnValue({
      runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/workspace/repo',
        ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
      }
    })
    computeWorktreePathMock.mockImplementation(
      (
        sanitizedName: string,
        repoPath: string,
        settings: { nestWorkspaces: boolean; workspaceDir: string }
      ) => {
        if (settings.nestWorkspaces) {
          const repoName =
            repoPath
              .split(/[\\/]/)
              .at(-1)
              ?.replace(/\.git$/, '') ?? 'repo'
          return `${settings.workspaceDir}/${repoName}/${sanitizedName}`
        }
        return `${settings.workspaceDir}/${sanitizedName}`
      }
    )
    listWorktreesMock.mockResolvedValue([])

    registerWorktreeHandlers(mainWindow as never, store as never)
  })

  it('rejects worktree creation when the branch already exists on a remote', async () => {
    getBranchConflictKindMock.mockResolvedValue('remote')

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow(
      'Branch "improve-dashboard" already exists on a remote. Pick a different worktree name.'
    )

    expect(getPRForBranchMock).not.toHaveBeenCalled()
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('lists a synthetic worktree for folder-mode repos', async () => {
    store.getRepos.mockReturnValue([
      {
        id: 'repo-1',
        path: '/workspace/folder',
        displayName: 'folder',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder'
      }
    ])
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })

    const listed = await handlers['worktrees:list'](null, { repoId: 'repo-1' })

    expect(listed).toEqual([
      expect.objectContaining({
        id: 'repo-1::/workspace/folder',
        repoId: 'repo-1',
        path: '/workspace/folder',
        displayName: 'folder',
        branch: '',
        head: '',
        isMainWorktree: true
      })
    ])
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('rejects worktree creation when the branch name already belongs to a PR', async () => {
    getPRForBranchMock.mockResolvedValue({
      number: 3127,
      title: 'Existing PR',
      state: 'merged',
      url: 'https://example.com/pr/3127',
      checksStatus: 'success',
      updatedAt: '2026-04-01T00:00:00Z',
      mergeable: 'UNKNOWN'
    })

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow(
      'Branch "improve-dashboard" already has PR #3127. Pick a different worktree name.'
    )

    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  const createdWorktreeList = [
    {
      path: '/workspace/improve-dashboard',
      head: 'abc123',
      branch: 'improve-dashboard',
      isBare: false,
      isMainWorktree: false
    }
  ]

  it('returns a setup launch payload when setup should run', async () => {
    listWorktreesMock.mockResolvedValue(createdWorktreeList)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    shouldRunSetupForCreateMock.mockReturnValue(true)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(createSetupRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      '/workspace/improve-dashboard',
      'pnpm worktree:setup'
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/workspace/improve-dashboard',
        branch: 'improve-dashboard'
      }),
      setup: {
        runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh',
        envVars: {
          ORCA_ROOT_PATH: '/workspace/repo',
          ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
        }
      }
    })
  })

  it('still returns the created worktree when setup runner generation fails', async () => {
    listWorktreesMock.mockResolvedValue(createdWorktreeList)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    shouldRunSetupForCreateMock.mockReturnValue(true)
    createSetupRunnerScriptMock.mockImplementation(() => {
      throw new Error('disk full')
    })

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(result).toEqual({
      worktree: expect.objectContaining({
        repoId: 'repo-1',
        path: '/workspace/improve-dashboard',
        branch: 'improve-dashboard'
      })
    })
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })

  it('rejects ask-policy creates before mutating git state when setup decision is missing', async () => {
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    shouldRunSetupForCreateMock.mockImplementation(() => {
      throw new Error('Setup decision required for this repository')
    })

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow('Setup decision required for this repository')

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(createSetupRunnerScriptMock).not.toHaveBeenCalled()
  })

  describe('gitignore:checkWorktreesIgnored handler', () => {
    function getCheckHandler(): (event: unknown, args: unknown) => Promise<unknown> {
      const entry = handleMock.mock.calls.find(
        (call) => call[0] === 'gitignore:checkWorktreesIgnored'
      )
      if (!entry) {
        throw new Error('gitignore:checkWorktreesIgnored not registered')
      }
      return entry[1] as (event: unknown, args: unknown) => Promise<unknown>
    }

    it('returns ignored: true when .gitignore contains .worktrees/', async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gi-handler-'))
      try {
        await fsWriteFile(pathJoin(dir, '.gitignore'), '.worktrees/\n', 'utf-8')
        store.getRepo.mockReturnValue({
          id: 'r1',
          path: dir,
          displayName: 'r',
          badgeColor: '#000',
          addedAt: 0
        })
        const handler = getCheckHandler()
        const result = await handler(null, { repoId: 'r1' })
        expect(result).toEqual({ ignored: true })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('returns ignored: false when .gitignore is missing', async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gi-handler-'))
      try {
        store.getRepo.mockReturnValue({
          id: 'r1',
          path: dir,
          displayName: 'r',
          badgeColor: '#000',
          addedAt: 0
        })
        const handler = getCheckHandler()
        const result = await handler(null, { repoId: 'r1' })
        expect(result).toEqual({ ignored: false })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('returns ignored: true for folder repos (short-circuit)', async () => {
      store.getRepo.mockReturnValue({
        id: 'r1',
        path: '/fake',
        displayName: 'r',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder'
      })
      const handler = getCheckHandler()
      const result = await handler(null, { repoId: 'r1' })
      expect(result).toEqual({ ignored: true })
    })

    it('returns ignored: true when the repo is not found (guard)', async () => {
      store.getRepo.mockReturnValue(undefined)
      const handler = getCheckHandler()
      const result = await handler(null, { repoId: 'missing' })
      expect(result).toEqual({ ignored: true })
    })
  })

  describe('gitignore:addWorktreesEntry handler', () => {
    function getAddHandler(): (event: unknown, args: unknown) => Promise<void> {
      const entry = handleMock.mock.calls.find((call) => call[0] === 'gitignore:addWorktreesEntry')
      if (!entry) {
        throw new Error('gitignore:addWorktreesEntry not registered')
      }
      return entry[1] as (event: unknown, args: unknown) => Promise<void>
    }

    it('creates .gitignore with the entry when it did not exist', async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gi-add-'))
      try {
        store.getRepo.mockReturnValue({
          id: 'r1',
          path: dir,
          displayName: 'r',
          badgeColor: '#000',
          addedAt: 0
        })
        const handler = getAddHandler()
        await handler(null, { repoId: 'r1' })
        const content = await readFile(pathJoin(dir, '.gitignore'), 'utf-8')
        expect(content).toBe('.worktrees/\n')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('appends to an existing .gitignore', async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), 'orca-gi-add-'))
      try {
        await fsWriteFile(pathJoin(dir, '.gitignore'), 'node_modules/\n', 'utf-8')
        store.getRepo.mockReturnValue({
          id: 'r1',
          path: dir,
          displayName: 'r',
          badgeColor: '#000',
          addedAt: 0
        })
        const handler = getAddHandler()
        await handler(null, { repoId: 'r1' })
        const content = await readFile(pathJoin(dir, '.gitignore'), 'utf-8')
        expect(content).toBe('node_modules/\n.worktrees/\n')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('throws for folder repos', async () => {
      store.getRepo.mockReturnValue({
        id: 'r1',
        path: '/fake',
        displayName: 'r',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder'
      })
      const handler = getAddHandler()
      await expect(handler(null, { repoId: 'r1' })).rejects.toThrow(
        'Cannot modify .gitignore for this repo type.'
      )
    })
  })
})
