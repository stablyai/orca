import { setImmediate as nextTurn } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RuntimeGitCommandHost, RuntimeGitTarget } from './runtime-git-command-target'

const mocks = vi.hoisted(() => ({
  getStagedCommitContext: vi.fn(),
  gitExecFileAsync: vi.fn(),
  getPullRequestDraftContext: vi.fn(),
  loadPullRequestLinkedIssue: vi.fn(),
  prepareLocalCommitMessageAgentEnv: vi.fn(),
  generateCommitMessageFromContext: vi.fn(),
  generatePullRequestFieldsFromContext: vi.fn(),
  resolveHostedReviewBodyForGeneration: vi.fn()
}))

const linkedLookup = vi.hoisted(() => ({ run: (): Promise<null> => Promise.resolve(null) }))

vi.mock('../../../git/source-control/mutations/staged-commit-context', () => ({
  getStagedCommitContext: mocks.getStagedCommitContext
}))
vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: mocks.gitExecFileAsync
}))
vi.mock('../../../text-generation/pull-request-context/pull-request-context', () => ({
  getPullRequestDraftContext: mocks.getPullRequestDraftContext
}))
vi.mock('../../../source-control/pull-request-linked-issue', () => ({
  loadPullRequestLinkedIssue: (...args: unknown[]) => {
    mocks.loadPullRequestLinkedIssue(...args)
    // A mock return observer would handle the rejection being tested.
    return linkedLookup.run()
  }
}))
vi.mock('../../../text-generation/execution/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepareLocalCommitMessageAgentEnv
}))
vi.mock('../../../text-generation/commit-message-text-generation', () => ({
  generateCommitMessageFromContext: mocks.generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext: mocks.generatePullRequestFieldsFromContext
}))
vi.mock('../../../source-control/pull-request-template', () => ({
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
    linkedLookup.run = () => Promise.resolve(null)
    mocks.resolveHostedReviewBodyForGeneration.mockImplementation(async ({ body }) => body)
    mocks.prepareLocalCommitMessageAgentEnv.mockResolvedValue({ ok: true, env: {} })
    mocks.generateCommitMessageFromContext.mockResolvedValue({ success: true, message: 'feat' })
    mocks.generatePullRequestFieldsFromContext.mockResolvedValue({ success: true, fields: {} })
  })

  describe('linked-issue lifetime', () => {
    function commands(): RuntimeGitGenerationCommands {
      return makeCommands(makeTarget('/repo'))
    }

    const input = { base: 'main', title: '', body: '', draft: false, provider: 'gitlab' as const }

    it.each(['no changes', 'context error', 'template error'])(
      'observes a late lookup rejection after %s',
      async (outcome) => {
        const issue = Promise.withResolvers<null>()
        linkedLookup.run = () => issue.promise
        const preparationError = new Error('preparation failed')
        mocks.getPullRequestDraftContext.mockResolvedValue(pullRequestContext)
        if (outcome === 'no changes') {
          mocks.getPullRequestDraftContext.mockResolvedValue(null)
        } else if (outcome === 'context error') {
          mocks.getPullRequestDraftContext.mockRejectedValue(preparationError)
        } else {
          mocks.resolveHostedReviewBodyForGeneration.mockRejectedValue(preparationError)
        }
        const unhandled = vi.fn()
        process.on('unhandledRejection', unhandled)
        try {
          await expect(
            commands().generateRuntimePullRequestFields('id:wt-1', input, settingsOverride)
          ).resolves.toMatchObject({
            success: false,
            error:
              outcome === 'no changes'
                ? 'No branch changes to summarize.'
                : preparationError.message
          })
          expect(mocks.loadPullRequestLinkedIssue).toHaveBeenCalledOnce()
          issue.reject(new Error('Timed out waiting for a GitLab operation slot.'))
          await nextTurn()
          expect(unhandled).not.toHaveBeenCalled()
          expect(mocks.generatePullRequestFieldsFromContext).not.toHaveBeenCalled()
        } finally {
          issue.resolve(null)
          void issue.promise.catch(() => undefined)
          process.off('unhandledRejection', unhandled)
        }
      }
    )

    it('observes rejection during preparation and preserves the later caller error', async () => {
      const issue = Promise.withResolvers<null>()
      const preparation = Promise.withResolvers<typeof pullRequestContext>()
      const failure = new Error('lookup admission failed')
      linkedLookup.run = () => issue.promise
      mocks.getPullRequestDraftContext.mockReturnValue(preparation.promise)
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      const result = commands()
        .generateRuntimePullRequestFields('id:wt-1', input, settingsOverride)
        .catch((error: unknown) => error)
      try {
        await nextTurn()
        expect(mocks.getPullRequestDraftContext).toHaveBeenCalledOnce()
        issue.reject(failure)
        await nextTurn()
        expect(unhandled).not.toHaveBeenCalled()
        preparation.resolve(pullRequestContext)
        expect(await result).toBe(failure)
        expect(mocks.generatePullRequestFieldsFromContext).not.toHaveBeenCalled()
      } finally {
        issue.resolve(null)
        preparation.resolve(pullRequestContext)
        await result
        process.off('unhandledRejection', unhandled)
      }
    })
  })
})
