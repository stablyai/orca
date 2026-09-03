import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  addWorktree,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  getActiveMultiplexerMock,
  getBranchConflictKind,
  getSshGitProviderMock,
  gitRunner,
  listWorktrees,
  muxRequestMock,
  registerSshGitProvider,
  unregisterSshGitProvider
} from '../orca-runtime-test-mocks.spec'
import type {
  WorkspaceLineage,
  WorktreeLineage,
  WorktreeMeta
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_REPO_PATH,
  createFolderWorkspaceRuntimeStore,
  isOriginMainBaseRefProbe,
  makeFolderWorkspace,
  makeWorktreeInfo,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('rejects when every exact PR branch checkout path suffix is occupied', async () => {
    const runtime = new OrcaRuntimeService(store)
    computeWorktreePathMock.mockReturnValue(process.cwd())
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(getBranchConflictKind).mockResolvedValueOnce(null)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/feature/fix^{commit}')) {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      await expect(
        runtime.createManagedWorktree({
          repoSelector: 'id:repo-1',
          name: 'fix-title',
          baseBranch: 'abc123',
          branchNameOverride: 'feature/fix'
        })
      ).rejects.toThrow(
        'Could not find an available worktree path for "fix-title". Pick a different worktree name.'
      )

      expect(addWorktree).not.toHaveBeenCalled()
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('creates SSH-backed worktrees through the SSH provider for mobile/runtime callers', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/repo-mobile-feature',
      head: 'def',
      branch: 'refs/heads/mobile-feature',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'mobile-feature',
      linkedGitLabIssue: 321,
      linkedGitLabMR: 654,
      startup: { command: 'claude' }
    })

    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'mobile-feature',
      '/remote/repo-mobile-feature',
      { base: 'origin/main' }
    )
    expect(result.worktree).toMatchObject({
      id: `${TEST_REPO_ID}::${created.path}`,
      path: created.path,
      linkedGitLabIssue: 321,
      linkedGitLabMR: 654
    })
    expect(metaById[result.worktree.id]).toMatchObject({
      linkedGitLabIssue: 321,
      linkedGitLabMR: 654
    })
    expect(addWorktree).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it.each([
    { direction: 'local to SSH', childConnectionId: null, parentHostId: 'ssh:parent' },
    { direction: 'SSH to local', childConnectionId: 'child', parentHostId: 'local' },
    {
      direction: 'SSH host A to SSH host B',
      childConnectionId: 'child',
      parentHostId: 'ssh:parent'
    }
  ] as const)('rejects $direction lineage before creating a worktree', async (scenario) => {
    const repo = {
      ...store.getRepo(TEST_REPO_ID)!,
      ...(scenario.childConnectionId ? { connectionId: scenario.childConnectionId } : {})
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined)
    } as never)
    const parentId = 'parent-repo::/parent'
    const parent = {
      id: parentId,
      repoId: 'parent-repo',
      path: '/parent',
      hostId: scenario.parentHostId,
      instanceId: 'parent-instance',
      head: 'abc',
      branch: 'parent',
      isBare: false,
      isMainWorktree: false,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: makeWorktreeInfo('/parent')
    }
    vi.spyOn(
      runtime as unknown as {
        resolveLineageForWorktreeCreate: () => Promise<unknown>
      },
      'resolveLineageForWorktreeCreate'
    ).mockResolvedValue({
      kind: 'lineage',
      parent: {
        type: 'worktree',
        workspaceKey: `worktree:${parentId}`,
        worktree: parent,
        instanceId: parent.instanceId
      },
      origin: 'cli',
      capture: { source: 'explicit-cli-flag', confidence: 'explicit' }
    })

    await expect(
      runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'child',
        lineage: { parentWorktree: `id:${parentId}` }
      })
    ).rejects.toMatchObject({
      code: 'LINEAGE_PARENT_CONTEXT_CONFLICT',
      message: 'Parent worktree must belong to the same execution host.'
    })

    expect(addWorktree).not.toHaveBeenCalled()
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
  })

  it.each([
    { direction: 'local to SSH', childConnectionId: null, parentConnectionId: 'parent' },
    { direction: 'SSH to local', childConnectionId: 'child', parentConnectionId: null },
    {
      direction: 'SSH host A to SSH host B',
      childConnectionId: 'child',
      parentConnectionId: 'parent'
    }
  ] as const)('rejects $direction folder lineage before creating a worktree', async (scenario) => {
    const repo = {
      ...store.getRepo(TEST_REPO_ID)!,
      ...(scenario.childConnectionId ? { connectionId: scenario.childConnectionId } : {})
    }
    const folderWorkspace = makeFolderWorkspace({ connectionId: scenario.parentConnectionId })
    const runtime = new OrcaRuntimeService({
      ...createFolderWorkspaceRuntimeStore(folderWorkspace),
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined)
    } as never)

    await expect(
      runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'child',
        lineage: { parentWorkspace: TEST_FOLDER_WORKSPACE_KEY }
      })
    ).rejects.toMatchObject({
      code: 'LINEAGE_PARENT_CONTEXT_CONFLICT',
      message: 'Parent worktree must belong to the same execution host.'
    })

    expect(addWorktree).not.toHaveBeenCalled()
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
  })

  it('records cross-repository lineage for SSH-backed CLI-created worktrees', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      hookSettings: {
        mode: 'auto' as const,
        setupRunPolicy: 'run-by-default' as const,
        setupAgentStartupPolicy: 'wait-for-setup' as const,
        scripts: { setup: '', archive: '' }
      }
    }
    const parentRepo = {
      ...remoteRepo,
      id: 'parent-repo',
      path: '/remote/parent-repo',
      displayName: 'parent repo'
    }
    const parent = {
      path: '/remote/parent-repo-parent',
      head: 'abc',
      branch: 'refs/heads/repo-parent',
      isBare: false,
      isMainWorktree: false
    }
    const created = {
      path: '/remote/child-feature',
      head: 'def',
      branch: 'refs/heads/child-feature',
      isBare: false,
      isMainWorktree: false
    }
    const parentId = `${parentRepo.id}::${parent.path}`
    const childId = `${TEST_REPO_ID}::${created.path}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const lineageById: Record<string, WorktreeLineage> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo, parentRepo],
      getRepo: (id: string) => [remoteRepo, parentRepo].find((repo) => repo.id === id),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: (worktreeId: string) => lineageById[worktreeId],
      setWorktreeLineage: vi.fn((worktreeId: string, lineage: WorktreeLineage) => {
        lineageById[worktreeId] = lineage
        return lineage
      })
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn(async (repoPath: string) =>
        repoPath === parentRepo.path ? [parent] : [created]
      )
    }
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'child-feature',
        lineage: { parentWorktree: `id:${parentId}` }
      })

      expect(result.worktree).toMatchObject({
        id: childId,
        parentWorktreeId: parentId,
        lineage: expect.objectContaining({
          worktreeId: childId,
          parentWorktreeId: parentId,
          worktreeInstanceId: metaById[childId].instanceId,
          parentWorktreeInstanceId: 'parent-instance',
          origin: 'cli'
        })
      })
      expect(result.lineage).toBe(result.worktree.lineage)
      expect(result.warnings).toEqual([])
      expect(remoteStore.setWorktreeLineage).toHaveBeenCalledWith(childId, expect.any(Object))
      expect(addWorktree).not.toHaveBeenCalled()
      expect(listWorktrees).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  // Why: the desktop composer sends `parentWorkspace` too, and a bare selector defaults to CLI
  // provenance — the same user action must not carry different cleanup semantics per host.
  it('records an app-selected parent workspace as a manual action', async () => {
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/tmp/workspaces/manual-child',
      head: 'def',
      branch: 'refs/heads/manual-child',
      isBare: false,
      isMainWorktree: false
    }
    const childId = `${TEST_REPO_ID}::${created.path}`
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...createFolderWorkspaceRuntimeStore(),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      setWorkspaceLineage: vi.fn((lineage: WorkspaceLineage) => lineage)
    }
    computeWorktreePathMock.mockReturnValue(created.path)
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(listWorktrees).mockResolvedValueOnce([created])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'manual-child',
      baseBranch: 'origin/main',
      lineage: {
        parentWorkspace: TEST_FOLDER_WORKSPACE_KEY,
        parentWorkspaceOrigin: 'manual'
      }
    })

    expect(result.workspaceLineage).toMatchObject({
      childWorkspaceKey: `worktree:${childId}`,
      parentWorkspaceKey: TEST_FOLDER_WORKSPACE_KEY,
      origin: 'manual',
      capture: { source: 'active-workspace', confidence: 'explicit' }
    })
  })

  it('records folder workspace lineage inferred from environment context', async () => {
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/tmp/workspaces/folder-child',
      head: 'def',
      branch: 'refs/heads/folder-child',
      isBare: false,
      isMainWorktree: false
    }
    const childId = `${TEST_REPO_ID}::${created.path}`
    const metaById: Record<string, WorktreeMeta> = {}
    const workspaceLineageByChildKey: Record<string, WorkspaceLineage> = {}
    const runtimeStore = {
      ...createFolderWorkspaceRuntimeStore(),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      setWorkspaceLineage: vi.fn((lineage: WorkspaceLineage) => {
        workspaceLineageByChildKey[lineage.childWorkspaceKey] = lineage
        return lineage
      })
    }
    computeWorktreePathMock.mockReturnValue(created.path)
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(listWorktrees).mockResolvedValueOnce([created])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'folder-child',
      baseBranch: 'origin/main',
      lineage: { envParentWorkspace: TEST_FOLDER_WORKSPACE_KEY }
    })

    expect(addWorktree).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      created.path,
      'folder-child',
      'origin/main',
      false
    )
    expect(result.lineage).toBeNull()
    expect(result.workspaceLineage).toMatchObject({
      childWorkspaceKey: `worktree:${childId}`,
      childInstanceId: metaById[childId].instanceId,
      parentWorkspaceKey: TEST_FOLDER_WORKSPACE_KEY,
      parentInstanceId: null,
      origin: 'cli',
      capture: { source: 'env-workspace', confidence: 'inferred' }
    })
    expect(result.worktree.workspaceLineage).toBe(result.workspaceLineage)
    expect(runtimeStore.setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        childWorkspaceKey: `worktree:${childId}`,
        parentWorkspaceKey: TEST_FOLDER_WORKSPACE_KEY
      })
    )
  })

  it('activates SSH worktrees created with startup agents', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/agent-feature',
      head: 'def',
      branch: 'refs/heads/agent-feature',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      hookSettings: {
        mode: 'auto' as const,
        setupRunPolicy: 'run-by-default' as const,
        setupAgentStartupPolicy: 'wait-for-setup' as const,
        scripts: { setup: '', archive: '' }
      }
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        terminalWindowsShell: 'cmd.exe',
        agentCmdOverrides: {}
      }),
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-agent-startup' })
    const activateWorktree = vi.fn()
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-remote-agent-startup' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'agent-feature',
        startupAgent: 'codex',
        startupPrompt: 'hi',
        activate: true
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/remote/agent-feature',
          command: "codex '--dangerously-bypass-approvals-and-sandbox' 'hi'",
          worktreeId: result.worktree.id
        })
      )
      expect(activateWorktree).toHaveBeenCalledWith(
        TEST_REPO_ID,
        result.worktree.id,
        undefined,
        undefined,
        undefined
      )
      expect(addWorktree).not.toHaveBeenCalled()
      expect(listWorktrees).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('quotes startup prompts for Windows SSH worktrees using PowerShell syntax', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: 'C:/remote/agent-feature',
      head: 'def',
      branch: 'refs/heads/agent-feature',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: 'C:/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        agentCmdOverrides: {}
      }),
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-windows-agent' })
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-remote-windows-agent' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    try {
      await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'agent-feature',
        startupAgent: 'codex',
        startupPrompt: "fix Bob's branch"
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: 'C:/remote/agent-feature',
          command: "codex '--dangerously-bypass-approvals-and-sandbox' 'fix Bob''s branch'"
        })
      )
      expect(addWorktree).not.toHaveBeenCalled()
      expect(listWorktrees).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })
})
