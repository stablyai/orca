import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  withPlatform,
  WORKSPACE_DIR,
  WORKTREE_FEATURE_PATH,
  discoverCommitMessageModelsLocalMock,
  discoverCommitMessageModelsRemoteMock,
  getSshGitProviderMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../local-downloaded-folder-promotion',
  async () => (await import('./filesystem-test-harness')).folderPromotionMock
)
vi.mock(
  '../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock('../git/worktree', async () => (await import('./filesystem-test-harness')).gitWorktreeMock)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./filesystem-test-harness')).sshFilesystemDispatchMock
)
vi.mock(
  '../providers/ssh-git-dispatch',
  async () => (await import('./filesystem-test-harness')).sshGitDispatchMock
)
vi.mock(
  '../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

describe('registerFilesystemHandlers', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    // Reset module-level auth cache so each test starts with a fresh dirty
    // flag — prevents stale worktree data from a prior test's cache rebuild.
    invalidateAuthorizedRootsCache()
  })

  it('passes per-agent command overrides into local model discovery', async () => {
    discoverCommitMessageModelsLocalMock.mockResolvedValue({
      success: true,
      capability: {
        id: 'codex',
        label: 'Codex',
        modelSource: 'dynamic',
        defaultModelId: 'gpt-5.5',
        models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }]
      },
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
      defaultModelId: 'gpt-5.5'
    })
    const storeWithOverride = {
      ...store,
      getSettings: () => ({
        workspaceDir: WORKSPACE_DIR,
        agentCmdOverrides: { codex: 'npx codex' }
      })
    }

    registerFilesystemHandlers(storeWithOverride as never)

    await handlers.get('git:discoverCommitMessageModels')!(null, { agentId: 'codex' })

    expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
      'codex',
      undefined,
      'npx codex'
    )
  })

  it('discovers models from an exact repo-less folder workspace root', async () => {
    const folderPath = path.resolve('/outside-workspace/folder-project')
    const folderStore = {
      ...store,
      getFolderWorkspaces: () => [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          folderPath,
          connectionId: null
        }
      ]
    }
    discoverCommitMessageModelsLocalMock.mockResolvedValue({
      success: true,
      models: [{ id: 'sonnet', label: 'Sonnet' }],
      defaultModelId: 'sonnet'
    })

    registerFilesystemHandlers(folderStore as never)

    await handlers.get('git:discoverCommitMessageModels')!(null, {
      agentId: 'claude',
      worktreePath: folderPath
    })

    expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
      'claude',
      undefined,
      undefined,
      { cwd: folderPath }
    )
  })

  it('does not authorize remote-only folder roots as local discovery paths', async () => {
    const folderPath = path.resolve('/remote-only/folder-project')
    const folderStore = {
      ...store,
      getFolderWorkspaces: () => [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          folderPath,
          connectionId: 'ssh-1'
        }
      ]
    }

    registerFilesystemHandlers(folderStore as never)

    await expect(
      handlers.get('git:discoverCommitMessageModels')!(null, {
        agentId: 'claude',
        worktreePath: folderPath
      })
    ).rejects.toThrow('Access denied')
    expect(discoverCommitMessageModelsLocalMock).not.toHaveBeenCalled()
  })

  it('routes a repo-less WSL folder workspace discovery through its distro', async () => {
    await withPlatform('win32', async () => {
      const folderPath = '\\\\wsl.localhost\\Ubuntu\\home\\tester\\folder-project'
      const prepareForClaudeLaunch = vi.fn().mockResolvedValue({
        configDir: '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.claude',
        envPatch: { CLAUDE_CONFIG_DIR: '/home/tester/.claude' },
        stripAuthEnv: true,
        provenance: 'managed:account-1'
      })
      const folderStore = {
        ...store,
        getFolderWorkspaces: () => [
          {
            id: 'folder-1',
            projectGroupId: 'group-1',
            folderPath,
            connectionId: null
          }
        ]
      }
      discoverCommitMessageModelsLocalMock.mockResolvedValue({
        success: true,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        defaultModelId: 'sonnet'
      })

      registerFilesystemHandlers(folderStore as never, { prepareForClaudeLaunch })

      await handlers.get('git:discoverCommitMessageModels')!(null, {
        agentId: 'claude',
        worktreePath: folderPath
      })

      expect(prepareForClaudeLaunch).toHaveBeenCalledWith({
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
        'claude',
        expect.objectContaining({ CLAUDE_CONFIG_DIR: '/home/tester/.claude' }),
        undefined,
        { cwd: path.resolve(folderPath), wslDistro: 'Ubuntu' }
      )
    })
  })

  it('routes local WSL project model discovery through the project runtime target', async () => {
    await withPlatform('win32', async () => {
      discoverCommitMessageModelsLocalMock.mockResolvedValue({
        success: true,
        capability: {
          id: 'codex',
          label: 'Codex',
          modelSource: 'dynamic',
          defaultModelId: 'gpt-5.5',
          models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }]
        },
        models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
        defaultModelId: 'gpt-5.5'
      })
      const prepareForCodexLaunch = vi.fn(() => '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.codex')
      const wslStore = {
        ...store,
        getRepos: () => [
          {
            id: 'repo-1',
            path: WORKTREE_FEATURE_PATH,
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 0
          }
        ],
        getProjects: () => [
          {
            id: 'project-1',
            sourceRepoIds: ['repo-1'],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
          }
        ],
        getSettings: () => ({
          workspaceDir: WORKSPACE_DIR,
          agentCmdOverrides: { codex: 'npx codex' },
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        })
      }

      registerFilesystemHandlers(wslStore as never, { prepareForCodexLaunch })

      await handlers.get('git:discoverCommitMessageModels')!(null, {
        agentId: 'codex',
        worktreePath: WORKTREE_FEATURE_PATH
      })

      expect(prepareForCodexLaunch).toHaveBeenCalledWith({
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ CODEX_HOME: '/home/tester/.codex' }),
        'npx codex',
        { cwd: WORKTREE_FEATURE_PATH, wslDistro: 'Ubuntu' }
      )
    })
  })

  it('routes SSH model discovery through the remote git provider', async () => {
    discoverCommitMessageModelsRemoteMock.mockResolvedValue({
      success: true,
      capability: {
        id: 'cursor',
        label: 'Cursor',
        modelSource: 'dynamic',
        defaultModelId: 'auto',
        models: [{ id: 'auto', label: 'Auto' }]
      },
      models: [{ id: 'auto', label: 'Auto' }],
      defaultModelId: 'auto'
    })
    const executeCommitMessagePlan = vi.fn()
    getSshGitProviderMock.mockReturnValue({ executeCommitMessagePlan })
    const storeWithOverride = {
      ...store,
      getSettings: () => ({
        workspaceDir: WORKSPACE_DIR,
        agentCmdOverrides: { cursor: 'npx cursor-agent' }
      })
    }

    registerFilesystemHandlers(storeWithOverride as never)

    await handlers.get('git:discoverCommitMessageModels')!(null, {
      agentId: 'cursor',
      worktreePath: '/remote/repo',
      connectionId: 'conn-1'
    })

    expect(discoverCommitMessageModelsRemoteMock).toHaveBeenCalledWith(
      'cursor',
      '/remote/repo',
      expect.any(Function),
      'npx cursor-agent'
    )
    const execute = discoverCommitMessageModelsRemoteMock.mock.calls[0]?.[2] as (
      plan: unknown,
      cwd: string,
      timeoutMs: number
    ) => Promise<unknown>
    await execute({ binary: 'cursor-agent', args: ['--list-models'] }, '/remote/repo', 60_000)
    expect(executeCommitMessagePlan).toHaveBeenCalledWith(
      { binary: 'cursor-agent', args: ['--list-models'] },
      '/remote/repo',
      60_000
    )
    expect(discoverCommitMessageModelsLocalMock).not.toHaveBeenCalled()
  })
})
