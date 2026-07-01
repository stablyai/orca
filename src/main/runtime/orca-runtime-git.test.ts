import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import type * as GitStatusModule from '../git/status'
import type * as CommitMessageTextGenerationModule from '../text-generation/commit-message-text-generation'
import type * as PullRequestContextModule from '../text-generation/pull-request-context'
import { RuntimeGitCommands, type ResolvedRuntimeGitWorktree } from './orca-runtime-git'

const mocks = vi.hoisted(() => ({
  abortMerge: vi.fn(),
  abortRebase: vi.fn(),
  checkoutBranch: vi.fn(),
  listLocalBranches: vi.fn(),
  getStagedCommitContext: vi.fn(),
  getPullRequestDraftContext: vi.fn(),
  generateCommitMessageFromContext: vi.fn(),
  generatePullRequestFieldsFromContext: vi.fn(),
  resolveCommitMessageSettings: vi.fn(),
  resolveHostedReviewBodyForGeneration: vi.fn(),
  getSshGitProvider: vi.fn()
}))

vi.mock('../git/status', async () => ({
  ...(await vi.importActual<typeof GitStatusModule>('../git/status')),
  abortMerge: mocks.abortMerge,
  abortRebase: mocks.abortRebase,
  getStagedCommitContext: mocks.getStagedCommitContext
}))

vi.mock('../git/checkout', () => ({
  checkoutBranch: mocks.checkoutBranch,
  listLocalBranches: mocks.listLocalBranches
}))

vi.mock('../text-generation/commit-message-text-generation', async () => ({
  ...(await vi.importActual<typeof CommitMessageTextGenerationModule>(
    '../text-generation/commit-message-text-generation'
  )),
  generateCommitMessageFromContext: mocks.generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext: mocks.generatePullRequestFieldsFromContext,
  resolveCommitMessageSettings: mocks.resolveCommitMessageSettings
}))

vi.mock('../text-generation/pull-request-context', async () => ({
  ...(await vi.importActual<typeof PullRequestContextModule>(
    '../text-generation/pull-request-context'
  )),
  getPullRequestDraftContext: mocks.getPullRequestDraftContext
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getSshGitProvider
}))

vi.mock('../source-control/pull-request-template', () => ({
  resolveHostedReviewBodyForGeneration: mocks.resolveHostedReviewBodyForGeneration
}))

const tempDirs: string[] = []

function makeWorktree(path: string): ResolvedRuntimeGitWorktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path,
    git: {
      path,
      branch: 'main',
      bare: false,
      detached: false,
      head: 'a'.repeat(40)
    }
  } as unknown as ResolvedRuntimeGitWorktree
}

function makeCommands(worktreePath: string): RuntimeGitCommands {
  return new RuntimeGitCommands({
    resolveRuntimeGitTarget: async () => ({ worktree: makeWorktree(worktreePath) }),
    getRuntimeSettings: () => ({}) as GlobalSettings
  })
}

describe('RuntimeGitCommands', () => {
  beforeEach(() => {
    mocks.abortMerge.mockReset()
    mocks.abortRebase.mockReset()
    mocks.getStagedCommitContext.mockReset()
    mocks.getPullRequestDraftContext.mockReset()
    mocks.generateCommitMessageFromContext.mockReset()
    mocks.generatePullRequestFieldsFromContext.mockReset()
    mocks.resolveCommitMessageSettings.mockReset()
    mocks.resolveHostedReviewBodyForGeneration.mockReset()
    mocks.resolveHostedReviewBodyForGeneration.mockImplementation(async ({ body }) => body)
    mocks.getSshGitProvider.mockReset()
    mocks.checkoutBranch.mockReset()
    mocks.listLocalBranches.mockReset()
  })

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it('aborts a local merge through the resolved worktree', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const commands = makeCommands(worktreePath)
    mocks.abortMerge.mockResolvedValue(undefined)

    await expect(commands.abortRuntimeGitMerge('id:wt-1')).resolves.toEqual({ ok: true })

    expect(mocks.abortMerge).toHaveBeenCalledWith(worktreePath, {})
  })

  it('aborts a remote merge through the SSH git provider', async () => {
    const provider = { abortMerge: vi.fn().mockResolvedValue(undefined) }
    mocks.getSshGitProvider.mockReturnValue(provider)
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: makeWorktree('/remote/repo'),
        connectionId: 'conn-1'
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await expect(commands.abortRuntimeGitMerge('id:wt-1')).resolves.toEqual({ ok: true })

    expect(provider.abortMerge).toHaveBeenCalledWith('/remote/repo')
    expect(mocks.abortMerge).not.toHaveBeenCalled()
  })

  it('aborts a local rebase through the resolved worktree', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const commands = makeCommands(worktreePath)
    mocks.abortRebase.mockResolvedValue(undefined)

    await expect(commands.abortRuntimeGitRebase('id:wt-1')).resolves.toEqual({ ok: true })

    expect(mocks.abortRebase).toHaveBeenCalledWith(worktreePath, {})
  })

  it('aborts a remote rebase through the SSH git provider', async () => {
    const provider = { abortRebase: vi.fn().mockResolvedValue(undefined) }
    mocks.getSshGitProvider.mockReturnValue(provider)
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: makeWorktree('/remote/repo'),
        connectionId: 'conn-1'
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await expect(commands.abortRuntimeGitRebase('id:wt-1')).resolves.toEqual({ ok: true })

    expect(provider.abortRebase).toHaveBeenCalledWith('/remote/repo')
    expect(mocks.abortRebase).not.toHaveBeenCalled()
  })

  it('checks out a local branch through the resolved worktree', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const commands = makeCommands(worktreePath)
    mocks.checkoutBranch.mockResolvedValue(undefined)

    await expect(commands.checkoutRuntimeGitBranch('id:wt-1', 'feature/x')).resolves.toEqual({
      ok: true,
      branch: 'feature/x'
    })

    expect(mocks.checkoutBranch).toHaveBeenCalledWith(worktreePath, 'feature/x', {})
  })

  it('checks out a remote branch through the SSH git provider', async () => {
    const provider = { checkoutBranch: vi.fn().mockResolvedValue(undefined) }
    mocks.getSshGitProvider.mockReturnValue(provider)
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: makeWorktree('/remote/repo'),
        connectionId: 'conn-1'
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await expect(commands.checkoutRuntimeGitBranch('id:wt-1', 'feature/x')).resolves.toEqual({
      ok: true,
      branch: 'feature/x'
    })

    expect(provider.checkoutBranch).toHaveBeenCalledWith('/remote/repo', 'feature/x')
    expect(mocks.checkoutBranch).not.toHaveBeenCalled()
  })

  it('lists local branches through the resolved worktree', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const commands = makeCommands(worktreePath)
    mocks.listLocalBranches.mockResolvedValue({ current: 'main', branches: ['main', 'feature/x'] })

    await expect(commands.listRuntimeGitLocalBranches('id:wt-1')).resolves.toEqual({
      current: 'main',
      branches: ['main', 'feature/x']
    })

    expect(mocks.listLocalBranches).toHaveBeenCalledWith(worktreePath, {})
  })

  it('lists remote local branches through the SSH git provider', async () => {
    const provider = {
      listLocalBranches: vi.fn().mockResolvedValue({ current: 'main', branches: ['main'] })
    }
    mocks.getSshGitProvider.mockReturnValue(provider)
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: makeWorktree('/remote/repo'),
        connectionId: 'conn-1'
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await expect(commands.listRuntimeGitLocalBranches('id:wt-1')).resolves.toEqual({
      current: 'main',
      branches: ['main']
    })

    expect(provider.listLocalBranches).toHaveBeenCalledWith('/remote/repo')
    expect(mocks.listLocalBranches).not.toHaveBeenCalled()
  })

  it('rejects slash-only git mutation paths before they can target the worktree root', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const commands = makeCommands(worktreePath)

    await expect(commands.bulkDiscardRuntimeGitPaths('id:wt-1', ['///'])).rejects.toThrow(
      'invalid_relative_path'
    )
    await expect(commands.discardRuntimeGitPath('id:wt-1', '///')).rejects.toThrow(
      'invalid_relative_path'
    )
  })

  it('prepares the selected local agent environment before generating commit messages', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const context = {
      branch: 'main',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    mocks.resolveCommitMessageSettings.mockReturnValue({ ok: true, params })
    mocks.getStagedCommitContext.mockResolvedValue(context)
    mocks.generateCommitMessageFromContext.mockResolvedValue({
      success: true,
      message: 'docs: update readme'
    })
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({ worktree: makeWorktree(worktreePath) }),
      getRuntimeSettings: () =>
        ({
          commitMessageAi: { enabled: true, agentId: 'codex' },
          agentCmdOverrides: {},
          enableGitHubAttribution: false
        }) as GlobalSettings,
      getCommitMessageAgentEnvironment: () => ({
        prepareForCodexLaunch: () => '/managed/codex-home'
      })
    })

    await expect(commands.generateRuntimeCommitMessage('id:wt-1')).resolves.toEqual({
      success: true,
      message: 'docs: update readme'
    })

    expect(mocks.resolveCommitMessageSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        commitMessageAi: { enabled: true, agentId: 'codex' }
      }),
      'local',
      'commitMessage',
      null
    )
    expect(mocks.generateCommitMessageFromContext).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'local',
        cwd: worktreePath,
        env: expect.objectContaining({ CODEX_HOME: '/managed/codex-home' })
      })
    )
  })

  it('routes local WSL project runtime commit-message generation through the runtime target', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const context = {
      branch: 'main',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    const prepareForCodexLaunch = vi.fn(() => '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.codex')
    mocks.resolveCommitMessageSettings.mockReturnValue({ ok: true, params })
    mocks.getStagedCommitContext.mockResolvedValue(context)
    mocks.generateCommitMessageFromContext.mockResolvedValue({
      success: true,
      message: 'docs: update readme'
    })
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: makeWorktree(worktreePath),
        localGitOptions: { wslDistro: 'Ubuntu' }
      }),
      getRuntimeSettings: () =>
        ({
          commitMessageAi: { enabled: true, agentId: 'codex' },
          agentCmdOverrides: {},
          enableGitHubAttribution: false
        }) as GlobalSettings,
      getCommitMessageAgentEnvironment: () => ({
        prepareForCodexLaunch
      })
    })

    await expect(commands.generateRuntimeCommitMessage('id:wt-1')).resolves.toEqual({
      success: true,
      message: 'docs: update readme'
    })

    expect(mocks.getStagedCommitContext).toHaveBeenCalledWith(worktreePath, {
      wslDistro: 'Ubuntu'
    })
    expect(prepareForCodexLaunch).toHaveBeenCalledWith({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(mocks.generateCommitMessageFromContext).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'local',
        cwd: worktreePath,
        wslDistro: 'Ubuntu',
        env: expect.objectContaining({ CODEX_HOME: '/home/tester/.codex' })
      })
    )
  })

  it('uses one-shot resolved params before runtime commit-message defaults', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const context = {
      branch: 'main',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const sourceControlAiResolvedParams = {
      agentId: 'codex' as const,
      model: 'gpt-5.5',
      thinkingLevel: 'high',
      customPrompt: 'Use Conventional Commits.'
    }
    mocks.getStagedCommitContext.mockResolvedValue(context)
    mocks.generateCommitMessageFromContext.mockResolvedValue({
      success: true,
      message: 'feat: update readme'
    })
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({ worktree: makeWorktree(worktreePath) }),
      getRuntimeSettings: () =>
        ({
          sourceControlAi: {
            commitMessage: {
              enabled: true,
              agentId: 'cursor',
              customPrompt: 'Saved default that should not win.'
            }
          }
        }) as unknown as GlobalSettings
    })

    await expect(
      commands.generateRuntimeCommitMessage('id:wt-1', { sourceControlAiResolvedParams })
    ).resolves.toEqual({
      success: true,
      message: 'feat: update readme'
    })

    expect(mocks.resolveCommitMessageSettings).not.toHaveBeenCalled()
    expect(mocks.generateCommitMessageFromContext).toHaveBeenCalledWith(
      context,
      sourceControlAiResolvedParams,
      expect.objectContaining({
        kind: 'local',
        cwd: worktreePath
      })
    )
  })

  it('uses one-shot resolved params before runtime pull-request defaults', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const context = {
      base: 'main',
      branch: 'feature/source-control-ai',
      commitSummary: 'abc123 feat: test',
      changeSummary: 'M README.md',
      patch: '+hello',
      currentTitle: '',
      currentBody: '',
      currentDraft: false
    }
    const sourceControlAiResolvedParams = {
      agentId: 'codex' as const,
      model: 'gpt-5.5',
      thinkingLevel: 'high',
      commandInputTemplate: '{basePrompt}\n\nUse release-note style.'
    }
    mocks.getPullRequestDraftContext.mockResolvedValue(context)
    mocks.generatePullRequestFieldsFromContext.mockResolvedValue({
      success: true,
      fields: {
        base: 'main',
        title: 'Improve Source Control AI',
        body: 'Body',
        draft: false
      }
    })
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({ worktree: makeWorktree(worktreePath) }),
      getRuntimeSettings: () =>
        ({
          sourceControlAi: {
            pullRequest: {
              enabled: true,
              agentId: 'cursor',
              customPrompt: 'Saved default that should not win.'
            }
          }
        }) as unknown as GlobalSettings
    })

    await expect(
      commands.generateRuntimePullRequestFields(
        'id:wt-1',
        { base: 'main', title: '', body: '', draft: false },
        { sourceControlAiResolvedParams }
      )
    ).resolves.toEqual({
      success: true,
      fields: {
        base: 'main',
        title: 'Improve Source Control AI',
        body: 'Body',
        draft: false
      }
    })

    expect(mocks.resolveCommitMessageSettings).not.toHaveBeenCalled()
    expect(mocks.generatePullRequestFieldsFromContext).toHaveBeenCalledWith(
      context,
      sourceControlAiResolvedParams,
      expect.objectContaining({
        kind: 'local',
        cwd: worktreePath
      })
    )
  })

  it('loads the hosted review template before generating pull-request fields', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))
    tempDirs.push(worktreePath)
    const templateBody = '## Summary\n\n## Testing\n\n- [ ] Required checks'
    const context = {
      base: 'main',
      branch: 'feature/template-aware-pr',
      branchChangedByPreparation: false,
      commitSummary: 'abc123 feat: test',
      changeSummary: 'M README.md',
      patch: '+hello',
      currentTitle: '',
      currentBody: templateBody,
      currentDraft: false
    }
    const sourceControlAiResolvedParams = {
      agentId: 'codex' as const,
      model: 'gpt-5.5'
    }
    mocks.resolveHostedReviewBodyForGeneration.mockResolvedValue(templateBody)
    mocks.getPullRequestDraftContext.mockResolvedValue(context)
    mocks.generatePullRequestFieldsFromContext.mockResolvedValue({
      success: true,
      fields: {
        base: 'main',
        title: 'Use existing template',
        body: templateBody,
        draft: false
      }
    })
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({ worktree: makeWorktree(worktreePath) }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await commands.generateRuntimePullRequestFields(
      'id:wt-1',
      {
        base: 'main',
        title: '',
        body: '',
        draft: false,
        provider: 'gitlab',
        useTemplate: true
      },
      { sourceControlAiResolvedParams }
    )

    expect(mocks.resolveHostedReviewBodyForGeneration).toHaveBeenCalledWith({
      body: '',
      repoPath: worktreePath,
      connectionId: undefined,
      provider: 'gitlab',
      useTemplate: true
    })
    expect(mocks.getPullRequestDraftContext).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        currentBody: templateBody
      })
    )
  })

  it('resolves remote commit-message settings against the SSH host cache', async () => {
    const worktreePath = '/remote/repo'
    const context = {
      branch: 'main',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'cursor', model: 'remote-model' }
    mocks.resolveCommitMessageSettings.mockReturnValue({ ok: true, params })
    mocks.generateCommitMessageFromContext.mockResolvedValue({
      success: true,
      message: 'docs: update remote readme'
    })
    const provider = {
      getStagedCommitContext: vi.fn().mockResolvedValue(context),
      executeCommitMessagePlan: vi.fn()
    }
    mocks.getSshGitProvider.mockReturnValue(provider)
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: makeWorktree(worktreePath),
        connectionId: 'conn-1'
      }),
      getRuntimeSettings: () =>
        ({
          commitMessageAi: {
            enabled: true,
            agentId: 'cursor',
            selectedModelByAgentByHost: { 'ssh:conn-1': { cursor: 'remote-model' } }
          }
        }) as unknown as GlobalSettings
    })

    await expect(commands.generateRuntimeCommitMessage('id:wt-1')).resolves.toEqual({
      success: true,
      message: 'docs: update remote readme'
    })

    expect(mocks.resolveCommitMessageSettings).toHaveBeenCalledWith(
      expect.any(Object),
      'ssh:conn-1',
      'commitMessage',
      null
    )
    expect(mocks.generateCommitMessageFromContext).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'remote',
        cwd: worktreePath
      })
    )
  })
})
