import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  withPlatform,
  WORKSPACE_DIR,
  WORKTREE_FEATURE_PATH,
  getStagedCommitContextMock,
  resolveCommitMessageSettingsMock,
  generateCommitMessageFromContextMock,
  cancelGenerateCommitMessageLocalMock,
  cancelGeneratePullRequestFieldsLocalMock,
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

  it('generates a local commit message from main-process staged context', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({ success: true, message: 'Update README' })

    expect(getStagedCommitContextMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      admissionTier: 'interactive'
    })
    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(context, params, {
      kind: 'local',
      cwd: WORKTREE_FEATURE_PATH
    })
  })

  it('uses one-shot resolved params for local commit message generation', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const sourceControlAiResolvedParams = {
      agentId: 'codex' as const,
      model: 'gpt-5.5',
      thinkingLevel: 'high',
      customPrompt: 'Use Conventional Commits.'
    }
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'feat: update readme'
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        sourceControlAiResolvedParams
      })
    ).resolves.toEqual({ success: true, message: 'feat: update readme' })

    expect(resolveCommitMessageSettingsMock).not.toHaveBeenCalled()
    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      context,
      sourceControlAiResolvedParams,
      {
        kind: 'local',
        cwd: WORKTREE_FEATURE_PATH
      }
    )
  })

  it('prepares the selected Codex account home before local generation', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    registerFilesystemHandlers(store as never, {
      prepareForCodexLaunch: () => '/managed/codex-home'
    })

    await handlers.get('git:generateCommitMessage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH
    })

    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'local',
        cwd: WORKTREE_FEATURE_PATH,
        env: expect.objectContaining({ CODEX_HOME: '/managed/codex-home' })
      })
    )
  })

  it('prepares the Orca-managed Codex home for the default system selection', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    registerFilesystemHandlers(store as never, {
      prepareForCodexLaunch: () => '/orca-managed/codex-home'
    })

    await handlers.get('git:generateCommitMessage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH
    })

    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'local',
        cwd: WORKTREE_FEATURE_PATH,
        env: expect.objectContaining({ CODEX_HOME: '/orca-managed/codex-home' })
      })
    )
  })

  it('routes local WSL project commit-message generation through the project runtime target', async () => {
    await withPlatform('win32', async () => {
      const context = {
        branch: 'feature/ai',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      }
      const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
      const prepareForCodexLaunch = vi.fn(() => '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.codex')
      resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
      getStagedCommitContextMock.mockResolvedValue(context)
      generateCommitMessageFromContextMock.mockResolvedValue({
        success: true,
        message: 'Update README'
      })
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
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        })
      }

      registerFilesystemHandlers(wslStore as never, { prepareForCodexLaunch })

      await handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })

      expect(getStagedCommitContextMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
        admissionTier: 'interactive',
        wslDistro: 'Ubuntu'
      })
      expect(prepareForCodexLaunch).toHaveBeenCalledWith({
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
        context,
        params,
        expect.objectContaining({
          kind: 'local',
          cwd: WORKTREE_FEATURE_PATH,
          wslDistro: 'Ubuntu',
          env: expect.objectContaining({ CODEX_HOME: '/home/tester/.codex' })
        })
      )
    })
  })

  it('enriches the local commit context with a validated worktree linked issue', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini' }
    const worktreeId = `repo-1::${WORKTREE_FEATURE_PATH}`
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({ success: true, message: 'Update' })
    const linkedStore = {
      ...store,
      getWorktreeMeta: (id: string) => (id === worktreeId ? { linkedIssue: 123 } : undefined)
    }

    registerFilesystemHandlers(linkedStore as never)

    await handlers.get('git:generateCommitMessage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      worktreeId
    })

    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      { ...context, linkedIssue: 123 },
      params,
      expect.objectContaining({ kind: 'local' })
    )
  })

  // Why: folder-repo instances keep `::workspace:<uuid>` on the meta key while the
  // request path is the stripped cwd. A strip-before-lookup "cleanup" would still
  // pass plain-id tests and silently lose enrichment on second workspaces.
  it('enriches local commit context when the worktree id carries a folder-repo workspace suffix', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini' }
    const instanceId = `repo-1::${WORKTREE_FEATURE_PATH}::workspace:${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({ success: true, message: 'Update' })
    const getWorktreeMeta = vi.fn((id: string) =>
      id === instanceId ? { linkedIssue: 9 } : undefined
    )

    registerFilesystemHandlers({ ...store, getWorktreeMeta } as never)

    await handlers.get('git:generateCommitMessage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      worktreeId: instanceId
    })

    expect(getWorktreeMeta).toHaveBeenCalledWith(instanceId)
    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      { ...context, linkedIssue: 9 },
      params,
      expect.objectContaining({ kind: 'local' })
    )
  })

  // Why: the renderer derives worktreePath from worktreeId, so a mismatched pair
  // models an independent caller (relay/CLI/future), not a stale renderer context.
  it('ignores an independently supplied id that does not own the requested worktree path', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini' }
    const getWorktreeMeta = vi.fn(() => ({ linkedIssue: 123 }))
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({ success: true, message: 'Update' })

    registerFilesystemHandlers({ ...store, getWorktreeMeta } as never)

    await handlers.get('git:generateCommitMessage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      worktreeId: `repo-1::${path.resolve('/workspace/repo-other')}`
    })

    expect(getWorktreeMeta).not.toHaveBeenCalled()
    // Why: without this the assertion below passes vacuously on an early return.
    expect(generateCommitMessageFromContextMock.mock.calls).toHaveLength(1)
    expect(generateCommitMessageFromContextMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'linkedIssue'
    )
  })

  it('enriches the SSH commit context from host meta using the remote path', async () => {
    const context = { branch: 'main', stagedSummary: 'A\tremote.txt', stagedPatch: '+remote' }
    const params = { agentId: 'custom', model: '', customAgentCommand: 'agent' }
    const worktreeId = 'repo-1::/remote/repo'
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getSshGitProviderMock.mockReturnValue({
      getStagedCommitContext: vi.fn().mockResolvedValue(context),
      executeCommitMessagePlan: vi.fn()
    })
    generateCommitMessageFromContextMock.mockResolvedValue({ success: true, message: 'Add file' })
    const linkedStore = {
      ...store,
      getWorktreeMeta: (id: string) => (id === worktreeId ? { linkedIssue: 77 } : undefined)
    }

    registerFilesystemHandlers(linkedStore as never)

    await handlers.get('git:generateCommitMessage')!(null, {
      worktreePath: '/remote/repo',
      worktreeId,
      connectionId: 'conn-1'
    })

    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      { ...context, linkedIssue: 77 },
      params,
      expect.objectContaining({ kind: 'remote' })
    )
  })

  it('returns a sanitized error when local agent account preparation fails', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)

    registerFilesystemHandlers(store as never, {
      prepareForCodexLaunch: () => {
        throw new Error('failed to read /Users/alice/.codex/auth.json')
      }
    })

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({
      success: false,
      error: 'Failed to prepare the selected agent account for commit message generation.'
    })
    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })

  it('prepares the selected Claude auth environment before local generation', async () => {
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'do-not-leak-managed-auth-conflict'
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'claude', model: 'haiku' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    try {
      registerFilesystemHandlers(store as never, {
        prepareForClaudeLaunch: async () => ({
          configDir: '/managed/claude',
          envPatch: { CLAUDE_CONFIG_DIR: '/managed/claude' },
          stripAuthEnv: true,
          provenance: 'managed:account-1'
        })
      })

      await handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })

      const target = generateCommitMessageFromContextMock.mock.calls[0]?.[2] as
        | { env?: NodeJS.ProcessEnv }
        | undefined
      expect(target?.env).toEqual(
        expect.objectContaining({
          CLAUDE_CONFIG_DIR: '/managed/claude'
        })
      )
      expect(target?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey
      }
    }
  })

  it('generates an SSH commit message using remote staged context and relay execution', async () => {
    const context = {
      branch: 'main',
      stagedSummary: 'A\tremote.txt',
      stagedPatch: '+remote'
    }
    const params = { agentId: 'custom', model: '', customAgentCommand: 'agent' }
    const executeCommitMessagePlan = vi.fn()
    const prepareForCodexLaunch = vi.fn(() => '/managed/codex-home')
    const prepareForClaudeLaunch = vi.fn()
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getSshGitProviderMock.mockReturnValue({
      getStagedCommitContext: vi.fn().mockResolvedValue(context),
      executeCommitMessagePlan
    })
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Add remote file'
    })

    registerFilesystemHandlers(store as never, {
      prepareForCodexLaunch,
      prepareForClaudeLaunch
    })

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: '/remote/repo',
        connectionId: 'conn-1'
      })
    ).resolves.toEqual({ success: true, message: 'Add remote file' })

    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'remote',
        cwd: '/remote/repo',
        missingBinaryLocation: 'remote PATH'
      })
    )
    const target = generateCommitMessageFromContextMock.mock.calls[0]?.[2]
    await target.execute(
      { binary: 'agent', args: [], stdinPayload: null, label: 'agent' },
      '/cwd',
      1,
      'commit-message'
    )
    expect(executeCommitMessagePlan).toHaveBeenCalledWith(
      { binary: 'agent', args: [], stdinPayload: null, label: 'agent' },
      '/cwd',
      1,
      'commit-message'
    )
    expect(prepareForCodexLaunch).not.toHaveBeenCalled()
    expect(prepareForClaudeLaunch).not.toHaveBeenCalled()
  })

  it('routes SSH generation cancellations to separate provider operations', async () => {
    const cancelGenerateCommitMessage = vi.fn().mockResolvedValue(undefined)
    getSshGitProviderMock.mockReturnValue({ cancelGenerateCommitMessage })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:cancelGenerateCommitMessage')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'conn-1'
    })
    await handlers.get('git:cancelGeneratePullRequestFields')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'conn-1'
    })

    expect(cancelGenerateCommitMessage).toHaveBeenNthCalledWith(1, '/remote/repo', 'commit-message')
    expect(cancelGenerateCommitMessage).toHaveBeenNthCalledWith(
      2,
      '/remote/repo',
      'pull-request-fields'
    )
    expect(cancelGenerateCommitMessageLocalMock).not.toHaveBeenCalled()
    expect(cancelGeneratePullRequestFieldsLocalMock).not.toHaveBeenCalled()
  })

  it('does not call the generator when no staged changes exist', async () => {
    resolveCommitMessageSettingsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4-mini' }
    })
    getStagedCommitContextMock.mockResolvedValue(null)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({ success: false, error: 'No staged changes to summarize.' })

    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })

  it('sanitizes local staged-context read failures before returning to the renderer', async () => {
    resolveCommitMessageSettingsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4-mini' }
    })
    getStagedCommitContextMock.mockRejectedValue(new Error('fatal: /secret/repo failed'))

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({ success: false, error: 'Failed to read staged changes.' })

    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })

  it('sanitizes SSH staged-context read failures before returning to the renderer', async () => {
    resolveCommitMessageSettingsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4-mini' }
    })
    getSshGitProviderMock.mockReturnValue({
      getStagedCommitContext: vi.fn().mockRejectedValue(new Error('fatal: /remote/secret failed'))
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: '/remote/repo',
        connectionId: 'conn-1'
      })
    ).resolves.toEqual({ success: false, error: 'Failed to read staged changes.' })

    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })
})
