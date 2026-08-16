import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { resolveRegisteredWorktreePath } from './registered-worktree-roots-cache'
import {
  listWorktreesMock,
  addWorktreeMock,
  resolveLocalGitUsernameMock,
  getBaseRefDefaultMock,
  getBranchConflictKindMock,
  getEffectiveHooksMock,
  createSetupRunnerScriptMock,
  getEffectiveHooksFromConfigMock,
  shouldRunSetupForCreateMock,
  loadHooksMock,
  computeWorktreePathMock,
  gitExecFileAsyncMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('prefetches the local default create base through the runtime refresh cache', async () => {
    const repo = {
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: 'origin/master'
    }
    const remoteBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    store.getRepo.mockReturnValue(repo)
    runtimeStub.resolveRemoteTrackingBase.mockImplementation(async (_repoPath, baseBranch) =>
      baseBranch === 'origin/main' ? remoteBase : null
    )
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(true)

    await handlers['worktrees:prefetchCreateBase'](null, { repoId: 'repo-1' })

    expect(getBaseRefDefaultMock).toHaveBeenCalledWith('/workspace/repo')
    expect(runtimeStub.resolveRemoteTrackingBase).toHaveBeenCalledWith(
      '/workspace/repo',
      'origin/master'
    )
    expect(runtimeStub.resolveRemoteTrackingBase).toHaveBeenCalledWith(
      '/workspace/repo',
      'origin/main'
    )
    expect(runtimeStub.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledWith(
      '/workspace/repo',
      remoteBase
    )
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('uses the runtime remote fetch cache when prefetching a local branch base', async () => {
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(null)

    await handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-1',
      baseBranch: 'main'
    })

    expect(runtimeStub.fetchRemoteWithCache).toHaveBeenCalledWith('/workspace/repo', 'origin')
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('prefetches origin for local branch bases containing slashes', async () => {
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(null)

    await handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-1',
      baseBranch: 'Jinwoo-H/vm-improve-2'
    })

    expect(runtimeStub.fetchRemoteWithCache).toHaveBeenCalledWith('/workspace/repo', 'origin')
    expect(runtimeStub.fetchRemoteWithCache).not.toHaveBeenCalledWith('/workspace/repo', 'Jinwoo-H')
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('does not prefetch the whole remote for an existing commit SHA base', async () => {
    const sha = 'a'.repeat(40)

    await handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-1',
      baseBranch: sha
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`],
      { cwd: '/workspace/repo' }
    )
    expect(runtimeStub.resolveRemoteTrackingBase).not.toHaveBeenCalled()
    expect(runtimeStub.fetchRemoteWithCache).not.toHaveBeenCalled()
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('skips the broad remote fetch when creating from an existing commit SHA base', async () => {
    const sha = 'a'.repeat(40)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/pr-title',
        head: sha,
        branch: 'refs/heads/feature/fix',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'pr-title',
      baseBranch: sha,
      branchNameOverride: 'feature/fix'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`],
      { cwd: '/workspace/repo' }
    )
    expect(runtimeStub.fetchRemoteWithCache).not.toHaveBeenCalled()
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/pr-title',
      'feature/fix',
      sha,
      false
    )
  })

  it('keeps the broad remote fetch fallback when a commit SHA base is missing locally', async () => {
    const sha = 'b'.repeat(40)
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes(`${sha}^{commit}`)) {
        throw new Error('missing object')
      }
      return { stdout: '', stderr: '' }
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/pr-title',
        head: sha,
        branch: 'refs/heads/feature/fix',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'pr-title',
      baseBranch: sha,
      branchNameOverride: 'feature/fix'
    })

    expect(runtimeStub.fetchRemoteWithCache).toHaveBeenCalledWith('/workspace/repo', 'origin')
    expect(addWorktreeMock).toHaveBeenCalled()
  })

  it('fetches origin when creating from a local branch base containing slashes', async () => {
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(null)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/slash-base',
        head: 'created-sha',
        branch: 'refs/heads/slash-base',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'slash-base',
      baseBranch: 'Jinwoo-H/vm-improve-2',
      branchNameOverride: 'slash-base'
    })

    expect(runtimeStub.fetchRemoteWithCache).toHaveBeenCalledWith('/workspace/repo', 'origin')
    expect(runtimeStub.fetchRemoteWithCache).not.toHaveBeenCalledWith('/workspace/repo', 'Jinwoo-H')
    expect(addWorktreeMock).toHaveBeenCalled()
  })

  it('auto-suffixes the branch name when the first choice collides with a remote branch', async () => {
    // Why: new-workspace flow should silently try improve-dashboard-2, -3, … rather than failing back to the name picker.
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

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })) as CreateWorktreeResult

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard-2',
      'improve-dashboard-2',
      'origin/main',
      false
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        path: '/workspace/improve-dashboard-2',
        branch: 'improve-dashboard-2'
      })
    })
  })

  it('keeps an emoji-only display name while using safe branch and path names', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/rocket',
        head: 'abc123',
        branch: 'rocket',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: '🚀'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/rocket',
      'rocket',
      'origin/main',
      false
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/rocket',
      expect.objectContaining({ displayName: '🚀' })
    )
  })

  it('uses a repo-specific worktree base path when creating local worktrees', async () => {
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null,
      worktreeBasePath: '../worktrees'
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '../worktrees/feature',
        head: 'abc123',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'feature'
    })

    expect(computeWorktreePathMock).toHaveBeenCalledWith('feature', '/workspace/repo', {
      nestWorkspaces: false,
      workspaceDir: '../worktrees'
    })
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '../worktrees/feature',
      'feature',
      'origin/main',
      false
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::../worktrees/feature',
      expect.objectContaining({
        orcaCreationWorkspaceLayout: { path: '../worktrees', nestWorkspaces: false }
      })
    )
  })

  it('registers local worktree roots immediately after create', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'base',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    const listWorktreesCallsAfterCreate = listWorktreesMock.mock.calls.length
    await expect(
      resolveRegisteredWorktreePath('/workspace/improve-dashboard', store as never)
    ).resolves.toBe(resolve('/workspace/improve-dashboard'))
    expect(listWorktreesMock).toHaveBeenCalledTimes(listWorktreesCallsAfterCreate)
  })

  it('uses branchNameOverride for the git branch while keeping the sanitized worktree path', async () => {
    store.getSettings.mockReturnValue({
      branchPrefix: 'git-username',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: '/workspace'
    })
    resolveLocalGitUsernameMock.mockResolvedValue('unused-user')
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/feature-something',
        head: 'abc123',
        branch: 'feature/something',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'feature/something',
      branchNameOverride: 'feature/something'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['check-ref-format', '--branch', 'feature/something'],
      { cwd: '/workspace/repo' }
    )
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-something',
      'feature/something',
      'origin/main',
      false
    )
    expect(resolveLocalGitUsernameMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        path: '/workspace/feature-something',
        branch: 'feature/something'
      })
    })
  })

  it('creates an additional workspace for folder-mode repos without git worktree add', async () => {
    const repo = {
      id: 'repo-folder',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder' as const
    }
    store.getRepo.mockReturnValue(repo)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => ({
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      ...meta
    }))

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-folder',
      name: 'folder-session',
      createdWithAgent: 'codex'
    })) as { worktree: { id: string } }

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(result.worktree).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^repo-folder::\/workspace\/folder::workspace:[0-9a-f-]{36}$/),
        repoId: 'repo-folder',
        path: '/workspace/folder',
        displayName: 'folder-session',
        instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        createdWithAgent: 'codex'
      })
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-folder'
    })
  })

  it('spawns a startup terminal and setup terminal after local worktree registration', async () => {
    addWorktreeMock.mockResolvedValue({})
    listWorktreesMock.mockResolvedValueOnce([
      {
        path: '/workspace/improve-dashboard',
        head: 'def',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    loadHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    shouldRunSetupForCreateMock.mockReturnValue(true)

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      createdWithAgent: 'claude',
      startup: {
        command: 'claude --prefill test',
        env: { ORCA_AGENT_MODE: 'direct' },
        viewMode: 'chat',
        telemetry: {
          agent_kind: 'claude',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      }
    })) as {
      setup?: unknown
      startupTerminal?: { spawned: boolean; surface?: string }
      timing?: { phases: { phase: string }[] }
    }

    expect(runtimeStub.createTerminal).toHaveBeenNthCalledWith(
      1,
      'id:repo-1::/workspace/improve-dashboard',
      {
        claudeAgentTeamsSourceCommand: 'claude --prefill test',
        command: 'claude --prefill test',
        env: { ORCA_AGENT_MODE: 'direct' },
        launchAgent: 'claude',
        viewMode: 'chat',
        startupCommandDelivery: undefined,
        telemetry: {
          agent_kind: 'claude',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        },
        activate: true
      }
    )
    expect(runtimeStub.createTerminal).toHaveBeenNthCalledWith(
      2,
      'id:repo-1::/workspace/improve-dashboard',
      {
        title: 'Setup',
        command: expect.stringContaining('bash /workspace/repo/.git/orca/setup-runner.sh'),
        env: {
          ORCA_ROOT_PATH: '/workspace/repo',
          ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
        },
        activate: false
      }
    )
    const startupCreateCall = runtimeStub.createTerminal.mock.calls[0]
    const setupCreateCall = runtimeStub.createTerminal.mock.calls[1]
    if (!startupCreateCall || !setupCreateCall) {
      throw new Error('expected startup and setup terminal calls')
    }
    const startupCommand = (startupCreateCall[1] as { command: string }).command
    const setupCommand = (setupCreateCall[1] as { command: string }).command
    expect(startupCommand).toBe('claude --prefill test')
    expect(setupCommand).toBe('bash /workspace/repo/.git/orca/setup-runner.sh')
    expect(result.setup).toBeUndefined()
    expect(result.startupTerminal).toEqual({ spawned: true, surface: 'visible' })
    expect(result.timing?.phases.map((phase) => phase.phase)).toEqual(
      expect.arrayContaining([
        'git_worktree_add',
        'list_created_worktree',
        'resolve_worktreeinclude',
        'prepare_setup',
        'spawn_startup_terminal'
      ])
    )
  })

  it('returns the wrapped setup command when startup spawned but setup creation failed', async () => {
    addWorktreeMock.mockResolvedValue({})
    listWorktreesMock.mockResolvedValueOnce([
      {
        path: '/workspace/improve-dashboard',
        head: 'def',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    loadHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    shouldRunSetupForCreateMock.mockReturnValue(true)
    createSetupRunnerScriptMock.mockReturnValueOnce({
      runnerScriptPath: 'C:\\workspace\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: 'C:\\workspace\\repo',
        ORCA_WORKTREE_PATH: 'C:\\workspace\\improve-dashboard'
      },
      waitForAgentStartup: true
    })
    runtimeStub.createTerminal
      .mockResolvedValueOnce({ handle: 'term-startup', surface: 'visible' })
      .mockRejectedValueOnce(new Error('setup creation failed'))

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      createdWithAgent: 'claude',
      startup: {
        command: 'claude --prefill test',
        env: { ORCA_AGENT_MODE: 'direct' },
        telemetry: {
          agent_kind: 'claude',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      }
    })) as { setup?: { command?: string; runnerScriptPath: string } }

    expect(result.setup).toEqual(
      expect.objectContaining({
        runnerScriptPath: 'C:\\workspace\\repo\\.git\\orca\\setup-runner.sh',
        command: expect.stringContaining('bash /mnt/c/workspace/repo/.git/orca/setup-runner.sh')
      })
    )
    expect(result.setup?.command).toContain('printf')
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
})
