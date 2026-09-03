import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RuntimeGitCommandHost, RuntimeGitTarget } from './runtime-git-command-target'

const mocks = vi.hoisted(() => ({
  getStagedCommitContext: vi.fn(),
  gitExecFileAsync: vi.fn(),
  getPullRequestDraftContext: vi.fn(),
  loadPullRequestLinkedIssue: vi.fn(),
  getSshGitProvider: vi.fn(),
  prepareLocalCommitMessageAgentEnv: vi.fn(),
  generateCommitMessageFromContext: vi.fn(),
  generatePullRequestFieldsFromContext: vi.fn(),
  resolveHostedReviewBodyForGeneration: vi.fn()
}))

vi.mock('../git/status', () => ({ getStagedCommitContext: mocks.getStagedCommitContext }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: mocks.gitExecFileAsync }))
vi.mock('../text-generation/pull-request-context', () => ({
  getPullRequestDraftContext: mocks.getPullRequestDraftContext
}))
vi.mock('../source-control/pull-request-linked-issue', () => ({
  loadPullRequestLinkedIssue: mocks.loadPullRequestLinkedIssue
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'provider unavailable'
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepareLocalCommitMessageAgentEnv
}))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateCommitMessageFromContext: mocks.generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext: mocks.generatePullRequestFieldsFromContext
}))
vi.mock('../source-control/pull-request-template', () => ({
  resolveHostedReviewBodyForGeneration: mocks.resolveHostedReviewBodyForGeneration
}))

import { RuntimeGitGenerationCommands } from './runtime-git-generation-commands'

const params = { agentId: 'codex' as const, model: 'gpt-5.5' }
const settingsOverride = { sourceControlAiResolvedParams: params }
const pullRequestContext = {
  base: 'main',
  branch: 'feature/admission',
  commitSummary: 'abc123 feat: test',
  changeSummary: 'M README.md',
  patch: '+hello',
  currentTitle: '',
  currentBody: '',
  currentDraft: false
}

function makeTarget(path: string, overrides: Partial<RuntimeGitTarget> = {}): RuntimeGitTarget {
  return {
    worktree: {
      id: 'wt-1',
      repoId: 'repo-1',
      path,
      git: { path, branch: 'main', isBare: false, isMainWorktree: false, head: 'a'.repeat(40) }
    } as RuntimeGitTarget['worktree'],
    executionHostId: 'local',
    ...overrides
  }
}

function makeCommands(target: RuntimeGitTarget): RuntimeGitGenerationCommands {
  const host: RuntimeGitCommandHost = {
    resolveRuntimeGitTarget: async () => target,
    getRuntimeSettings: () => ({}) as GlobalSettings
  }
  return new RuntimeGitGenerationCommands(host)
}

describe('RuntimeGitGenerationCommands admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.gitExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
    mocks.loadPullRequestLinkedIssue.mockResolvedValue(null)
    mocks.resolveHostedReviewBodyForGeneration.mockImplementation(async ({ body }) => body)
    mocks.prepareLocalCommitMessageAgentEnv.mockResolvedValue({ ok: true, env: {} })
    mocks.generateCommitMessageFromContext.mockResolvedValue({ success: true, message: 'feat' })
    mocks.generatePullRequestFieldsFromContext.mockResolvedValue({ success: true, fields: {} })
  })

  it('marks local staged commit context as interactive without dropping WSL routing', async () => {
    mocks.getStagedCommitContext.mockResolvedValue({
      branch: 'main',
      stagedSummary: 'M README.md',
      stagedPatch: '+hello'
    })
    const commands = makeCommands(
      makeTarget('C:\\repo', { localGitOptions: { wslDistro: 'Ubuntu' } })
    )

    await commands.generateRuntimeCommitMessage('id:wt-1', settingsOverride)

    expect(mocks.getStagedCommitContext).toHaveBeenCalledWith('C:\\repo', {
      wslDistro: 'Ubuntu',
      admissionTier: 'interactive'
    })
  })

  it('marks local pull-request context and linked-issue reads as interactive', async () => {
    mocks.getPullRequestDraftContext.mockImplementation(async (execute) => {
      await execute(['fetch', 'origin', 'main'], { timeout: 123 })
      await execute(['show-ref', '--verify'], { maxBuffer: 456, timeoutMs: 789 })
      return pullRequestContext
    })
    const commands = makeCommands(
      makeTarget('C:\\repo', { localGitOptions: { wslDistro: 'Ubuntu' } })
    )

    await commands.generateRuntimePullRequestFields(
      'id:wt-1',
      { base: 'main', title: '', body: '', draft: false },
      settingsOverride
    )

    expect(mocks.gitExecFileAsync).toHaveBeenCalledWith(['fetch', 'origin', 'main'], {
      cwd: 'C:\\repo',
      wslDistro: 'Ubuntu',
      timeout: 123,
      admissionTier: 'interactive'
    })
    expect(mocks.gitExecFileAsync).toHaveBeenCalledWith(['show-ref', '--verify'], {
      cwd: 'C:\\repo',
      wslDistro: 'Ubuntu',
      maxBuffer: 456,
      timeout: 789,
      admissionTier: 'interactive'
    })
    expect(mocks.loadPullRequestLinkedIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: undefined,
        localGitOptions: { wslDistro: 'Ubuntu', admissionTier: 'interactive' }
      })
    )
  })

  it('keeps SSH pull-request context reads on the remote provider', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    mocks.getSshGitProvider.mockReturnValue({ exec, executeCommitMessagePlan: vi.fn() })
    mocks.getPullRequestDraftContext.mockImplementation(async (execute) => {
      await execute(['log', '--oneline'])
      await execute(['show-ref', '--verify'], { maxBuffer: 456, timeoutMs: 789 })
      return pullRequestContext
    })
    const commands = makeCommands(
      makeTarget('/remote/repo', {
        executionHostId: 'ssh:conn-1',
        localGitOptions: { wslDistro: 'Ubuntu' }
      })
    )

    await commands.generateRuntimePullRequestFields(
      'id:wt-1',
      { base: 'main', title: '', body: '', draft: false },
      settingsOverride
    )

    expect(exec).toHaveBeenCalledWith(['log', '--oneline'], '/remote/repo')
    expect(exec).toHaveBeenCalledWith(['show-ref', '--verify'], '/remote/repo', { timeoutMs: 789 })
    expect(mocks.gitExecFileAsync).not.toHaveBeenCalled()
    expect(mocks.loadPullRequestLinkedIssue).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn-1', localGitOptions: {} })
    )
  })
})
