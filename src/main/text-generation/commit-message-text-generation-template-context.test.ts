import { describe, expect, it, vi } from 'vitest'
import {
  generateBranchNameFromContext,
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext
} from './commit-message-text-generation'

// A template that references no context variable renders verbatim, so the real
// staged diff never reaches the agent (#20112). Generation must refuse it
// instead of describing whatever text the template happens to contain.
describe('command templates without work context', () => {
  const COMMIT_CONTEXT = {
    branch: 'fix/login-timeout',
    stagedSummary: 'M src/session/login-timeout.ts',
    stagedPatch: 'diff --git a/src/session/login-timeout.ts b/src/session/login-timeout.ts'
  }
  const PULL_REQUEST_CONTEXT = {
    branch: 'fix/login-timeout',
    base: 'main',
    branchChangedByPreparation: false,
    currentTitle: '',
    currentBody: '',
    currentDraft: false,
    commitSummary: 'f00dfee Extend login timeout',
    changeSummary: 'src/session/login-timeout.ts | 2 +-',
    patch: 'diff --git a/src/session/login-timeout.ts b/src/session/login-timeout.ts'
  }

  // The rendered `{basePrompt}` preview a user can copy out of the variable
  // hover card: it looks like a full prompt but contains no placeholders.
  const COPIED_PREVIEW_TEMPLATE = [
    'You are generating a single git commit message.',
    'Rules:',
    '- Follow the conventional commit rules',
    'Branch: feature/example',
    'Staged files:',
    'M src/example.ts',
    'Staged patch:',
    'diff --git a/src/example.ts b/src/example.ts',
    '+addSourceControlAiPreview()'
  ].join('\n')

  function params(commandInputTemplate: string): {
    agentId: 'custom'
    model: string
    customAgentCommand: string
    commandInputTemplate: string
  } {
    return { agentId: 'custom', model: '', customAgentCommand: 'agent', commandInputTemplate }
  }

  function recordingTarget(stdout: string): {
    target: {
      kind: 'remote'
      cwd: string
      missingBinaryLocation: string
      execute: (plan: { stdinPayload: string | null }) => Promise<{
        stdout: string
        stderr: string
        exitCode: number
        timedOut: boolean
      }>
    }
    execute: ReturnType<typeof vi.fn>
    prompts: string[]
  } {
    const prompts: string[] = []
    const execute = vi.fn(async (plan: { stdinPayload: string | null }) => {
      prompts.push(plan.stdinPayload ?? '')
      return { stdout, stderr: '', exitCode: 0, timedOut: false }
    })
    return {
      target: { kind: 'remote', cwd: '/repo', missingBinaryLocation: 'remote PATH', execute },
      execute,
      prompts
    }
  }

  it('refuses a commit-message template copied from the base prompt preview', async () => {
    const run = recordingTarget('feat: add source control AI preview')

    const result = await generateCommitMessageFromContext(
      COMMIT_CONTEXT,
      params(COPIED_PREVIEW_TEMPLATE),
      run.target
    )

    expect(run.execute).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.success ? '' : result.error).toContain('{basePrompt}')
  })

  it('refuses a commit-message template whose only variables carry no staged changes', async () => {
    const run = recordingTarget('chore: update')

    const result = await generateCommitMessageFromContext(
      COMMIT_CONTEXT,
      params('Write a commit message for {branch}. Fixes #{linkedIssue}'),
      run.target
    )

    expect(run.execute).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
  })

  it('accepts a commit-message template that references the staged patch without the base prompt', async () => {
    const run = recordingTarget('fix: extend login timeout')

    const result = await generateCommitMessageFromContext(
      COMMIT_CONTEXT,
      params('Summarize this diff as one commit subject:\n{{ stagedPatch }}'),
      run.target
    )

    expect(result.success).toBe(true)
    expect(run.prompts[0]).toContain(COMMIT_CONTEXT.stagedPatch)
  })

  it('refuses a pull-request template without branch changes', async () => {
    const run = recordingTarget('{"base":"main","title":"t","body":"b","draft":false}')

    const result = await generatePullRequestFieldsFromContext(
      PULL_REQUEST_CONTEXT,
      params('Write a PR title and body. Base: {baseBranch}'),
      run.target
    )

    expect(run.execute).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
  })

  it('refuses a branch-name template without the work description', async () => {
    const run = recordingTarget('add-source-control-ai-preview')

    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Extend the login timeout' },
      params('Suggest a short kebab-case branch name.'),
      run.target
    )

    expect(run.execute).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
  })

  it.each([undefined, '', 'I will inspect the task'])(
    'refuses assistant-only branch templates when the reply is %s',
    async (assistantMessage) => {
      const run = recordingTarget('extend-login-timeout')
      const result = await generateBranchNameFromContext(
        { firstPrompt: 'Extend the login timeout', assistantMessage },
        params('Name this: {assistantMessage}'),
        run.target
      )
      expect(result.success).toBe(false)
      expect(run.execute).not.toHaveBeenCalled()
    }
  )

  it.each(['{firstPrompt}', '{basePrompt}', '{firstPrompt}\n{assistantMessage}'])(
    'forwards the task through a branch template containing %s',
    async (template) => {
      const run = recordingTarget('extend-login-timeout')
      const result = await generateBranchNameFromContext(
        { firstPrompt: 'Extend the login timeout' },
        params(template),
        run.target
      )
      expect(result.success).toBe(true)
      expect(run.prompts[0]).toContain('Extend the login timeout')
    }
  )
})
