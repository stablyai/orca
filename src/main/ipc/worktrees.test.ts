/* eslint-disable max-lines */
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
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  gitExecFileAsyncMock,
  isBareRepoMock,
  isWorktreesDirIgnoredMock,
  addWorktreesDirToGitignoreMock
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
  runHookMock: vi.fn(),
  hasHooksFileMock: vi.fn(),
  loadHooksMock: vi.fn(),
  computeWorktreePathMock: vi.fn(),
  ensurePathWithinWorkspaceMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  isBareRepoMock: vi.fn(),
  isWorktreesDirIgnoredMock: vi.fn(),
  addWorktreesDirToGitignoreMock: vi.fn()
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
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn()
}))

vi.mock('../git/repo', () => ({
  getGitUsername: getGitUsernameMock,
  getDefaultBaseRef: getDefaultBaseRefMock,
  getBranchConflictKind: getBranchConflictKindMock,
  isBareRepo: isBareRepoMock
}))

vi.mock('../git/gitignore', () => ({
  isWorktreesDirIgnored: isWorktreesDirIgnoredMock,
  addWorktreesDirToGitignore: addWorktreesDirToGitignoreMock
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
  shouldRunSetupForCreate: shouldRunSetupForCreateMock
}))

vi.mock('./worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    computeWorktreePath: computeWorktreePathMock,
    ensurePathWithinWorkspace: ensurePathWithinWorkspaceMock
  }
})

const { deleteWorktreeHistoryDirMock } = vi.hoisted(() => ({
  deleteWorktreeHistoryDirMock: vi.fn()
}))

vi.mock('../terminal-history', () => ({
  deleteWorktreeHistoryDir: deleteWorktreeHistoryDirMock
}))

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
      createIssueCommandRunnerScriptMock,
      createSetupRunnerScriptMock,
      shouldRunSetupForCreateMock,
      runHookMock,
      hasHooksFileMock,
      loadHooksMock,
      computeWorktreePathMock,
      ensurePathWithinWorkspaceMock,
      gitExecFileAsyncMock,
      isBareRepoMock,
      isWorktreesDirIgnoredMock,
      addWorktreesDirToGitignoreMock,
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
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: '/workspace',
      worktreeLocation: 'external'
    })
    isBareRepoMock.mockReturnValue(false)
    isWorktreesDirIgnoredMock.mockResolvedValue(false)
    addWorktreesDirToGitignoreMock.mockResolvedValue(undefined)
    store.getWorktreeMeta.mockReturnValue(undefined)
    store.setWorktreeMeta.mockReturnValue({})
    getGitUsernameMock.mockReturnValue('')
    getDefaultBaseRefMock.mockReturnValue('origin/main')
    getBranchConflictKindMock.mockResolvedValue(null)
    getPRForBranchMock.mockResolvedValue(null)
    // Why: createLocalWorktree now fires `git fetch` in the background via
    // gitExecFileAsync. The default mock must return a resolved promise so
    // the fire-and-forget `.catch()` chain doesn't trip on undefined.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    getEffectiveHooksMock.mockReturnValue(null)
    shouldRunSetupForCreateMock.mockReturnValue(false)
    createSetupRunnerScriptMock.mockReturnValue({
      runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/workspace/repo',
        ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
      }
    })
    createIssueCommandRunnerScriptMock.mockReturnValue({
      runnerScriptPath: '/workspace/repo/.git/orca/issue-command-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/workspace/repo',
        ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
      }
    })
    computeWorktreePathMock.mockImplementation(
      (
        sanitizedName: string,
        repoPath: string,
        settings: { nestWorkspaces: boolean; workspaceDir: string; worktreeLocation?: string }
      ) => {
        if (settings.worktreeLocation === 'in-repo') {
          return `${repoPath}/.worktrees/${sanitizedName}`
        }
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
    ensurePathWithinWorkspaceMock.mockImplementation((targetPath: string) => targetPath)
    listWorktreesMock.mockResolvedValue([])

    registerWorktreeHandlers(mainWindow as never, store as never)
  })

  it('auto-suffixes the branch name when the first choice collides with a remote branch', async () => {
    // Why: new-workspace flow should silently try improve-dashboard-2, -3, ...
    // rather than failing and forcing the user back to the name picker.
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'improve-dashboard' ? 'remote' : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard-2',
        head: 'abc123',
        branch: 'improve-dashboard-2',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard-2',
      'improve-dashboard-2',
      'origin/main',
      false
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        path: '/workspace/improve-dashboard-2',
        branch: 'improve-dashboard-2'
      })
    })
  })

  it('throws a clear error when no default base ref can be resolved', async () => {
    // Why: guard against regressing to a silent 'origin/main' fallback. When
    // getDefaultBaseRef returns null (e.g. a fresh repo with no origin/HEAD,
    // no origin/main, no origin/master, and no local main/master), we must
    // fail loudly with a message that prompts the user to pick a base
    // branch, not hand a non-existent ref to `git worktree add`.
    getDefaultBaseRefMock.mockReturnValue(null)
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    })

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow(/Could not resolve a default base ref/)
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('creates an issue-command runner for an existing repo/worktree pair', async () => {
    const result = await handlers['hooks:createIssueCommandRunner'](null, {
      repoId: 'repo-1',
      worktreePath: '/workspace/improve-dashboard',
      command: 'codex exec "long command"'
    })

    expect(createIssueCommandRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      '/workspace/improve-dashboard',
      'codex exec "long command"'
    )
    expect(result).toEqual({
      runnerScriptPath: '/workspace/repo/.git/orca/issue-command-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/workspace/repo',
        ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
      }
    })
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

  it('skips past a suffix that already belongs to a PR after an initial branch conflict', async () => {
    // Why: `gh pr list` is network-bound and previously fired on every single
    // create, adding 1–3s to the happy path. We now only probe PR conflicts
    // from suffix=2 onward — once a local/remote branch collision has already
    // forced us past the first candidate and uniqueness matters enough to
    // justify the GitHub round-trip. This test covers that delayed path:
    // suffix=1 is a branch conflict, suffix=2 is owned by an old PR, so the
    // loop lands on suffix=3.
    getBranchConflictKindMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'improve-dashboard' ? 'remote' : null
    )
    getPRForBranchMock.mockImplementation(async (_repoPath: string, branch: string) =>
      branch === 'improve-dashboard-2'
        ? {
            number: 3127,
            title: 'Existing PR',
            state: 'merged',
            url: 'https://example.com/pr/3127',
            checksStatus: 'success',
            updatedAt: '2026-04-01T00:00:00Z',
            mergeable: 'UNKNOWN'
          }
        : null
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard-3',
        head: 'abc123',
        branch: 'improve-dashboard-3',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard-3',
      'improve-dashboard-3',
      'origin/main',
      false
    )
    expect(result).toEqual({
      worktree: expect.objectContaining({
        path: '/workspace/improve-dashboard-3',
        branch: 'improve-dashboard-3'
      })
    })
  })

  it('does not call `gh pr list` on the happy path (no branch conflict)', async () => {
    // Why: guards the speed optimization. If a future refactor accidentally
    // reintroduces the PR probe on the first iteration, the happy path will
    // silently regain a 1–3s GitHub round-trip per click; this test fails
    // loudly instead.
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(getPRForBranchMock).not.toHaveBeenCalled()
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
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      'origin/main',
      false
    )
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

  it('prunes git worktree tracking when removing an orphaned worktree', async () => {
    const orphanError = Object.assign(new Error('git worktree remove failed'), {
      stderr: "fatal: '/workspace/feature-wt' is not a working tree"
    })
    removeWorktreeMock.mockRejectedValue(orphanError)
    getEffectiveHooksMock.mockReturnValue(null)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    // Should have called git worktree prune to clean up stale tracking
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'prune'], {
      cwd: '/workspace/repo'
    })
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith('repo-1::/workspace/feature-wt')
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith('repo-1::/workspace/feature-wt')
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

  // Why this test exists: an earlier rewrite of computeWorktreePath returned
  // <repo>/.worktrees/<name> for in-repo mode but createLocalWorktree still
  // wrapped it with ensurePathWithinWorkspace against settings.workspaceDir,
  // which throws "Invalid worktree path" because the in-repo path is not a
  // descendant of workspaceDir. That broke in-repo creation end-to-end. This
  // test pins the right behavior: when worktreeLocation is in-repo, the
  // create succeeds and the path-traversal guard is run against the
  // <repo>/.worktrees root, not workspaceDir.
  it('creates worktree at <repo>/.worktrees/<name> when worktreeLocation is in-repo', async () => {
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: '/workspace',
      worktreeLocation: 'in-repo'
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo/.worktrees/improve-dashboard',
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
      '/workspace/repo',
      '/workspace/repo/.worktrees/improve-dashboard',
      'improve-dashboard',
      'origin/main',
      false
    )
    // Pin the workspaceRoot argument: ensurePathWithinWorkspace must be
    // called against <repo>/.worktrees, not settings.workspaceDir.
    expect(ensurePathWithinWorkspaceMock).toHaveBeenCalledWith(
      '/workspace/repo/.worktrees/improve-dashboard',
      '/workspace/repo/.worktrees'
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        path: '/workspace/repo/.worktrees/improve-dashboard',
        branch: 'refs/heads/improve-dashboard'
      })
    })
  })

  it('rejects in-repo worktree creation on bare repos with a clear error', async () => {
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: '/workspace',
      worktreeLocation: 'in-repo'
    })
    isBareRepoMock.mockReturnValue(true)

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow(/bare repositories/i)

    // No git mutation should have happened — the gate is pre-flight.
    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(computeWorktreePathMock).not.toHaveBeenCalled()
  })

  it('does not gate on bare repo when worktreeLocation is external', async () => {
    // Why this test exists: the bare-repo guard must only fire when the
    // user has opted into in-repo mode. External-mode worktrees on bare
    // repos are a normal, supported case (peer worktrees alongside the
    // bare object directory).
    isBareRepoMock.mockReturnValue(true)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
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

    expect(addWorktreeMock).toHaveBeenCalled()
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        path: '/workspace/improve-dashboard'
      })
    })
  })
})
