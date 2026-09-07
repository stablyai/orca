import { describe, expect, it } from 'vitest'
import {
  generateBranchNameFromContext,
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext
} from './commit-message-text-generation'

describe('linkedIssue template substitution', () => {
  const COMMIT_CONTEXT = {
    branch: 'feature/login',
    stagedSummary: 'M src/login.ts',
    stagedPatch: 'diff --git a/src/login.ts b/src/login.ts'
  }
  const PULL_REQUEST_CONTEXT = {
    branch: 'feature/login',
    base: 'main',
    branchChangedByPreparation: false,
    currentTitle: 'Fix login',
    currentBody: '',
    currentDraft: false,
    commitSummary: 'a1b2c3d Fix login',
    changeSummary: 'src/login.ts | 4 ++--',
    patch: 'diff --git a/src/login.ts b/src/login.ts'
  }

  function capturingTarget(capture: (prompt: string) => void): {
    kind: 'remote'
    cwd: string
    missingBinaryLocation: string
    execute: (plan: { stdinPayload: string | null }) => Promise<{
      stdout: string
      stderr: string
      exitCode: number
      timedOut: boolean
    }>
  } {
    return {
      kind: 'remote',
      cwd: '/repo',
      missingBinaryLocation: 'remote PATH',
      execute: async (plan) => {
        capture(plan.stdinPayload ?? '')
        return {
          stdout: '{"base":"main","title":"Fix login","body":"body","draft":false}',
          stderr: '',
          exitCode: 0,
          timedOut: false
        }
      }
    }
  }

  const templateParams = {
    agentId: 'custom' as const,
    model: '',
    customAgentCommand: 'agent',
    commandInputTemplate: '{basePrompt}\n\nFixes #{linkedIssue}'
  }

  it('substitutes the linked issue into the commit-message prompt', async () => {
    let prompt = ''
    await generateCommitMessageFromContext(
      { ...COMMIT_CONTEXT, linkedIssue: 42 },
      templateParams,
      capturingTarget((value) => {
        prompt = value
      })
    )

    expect(prompt).toContain('Fixes #42')
    expect(prompt).not.toContain('{linkedIssue}')
  })

  it('renders an empty commit-message issue for null and omitted fields', async () => {
    for (const context of [{ ...COMMIT_CONTEXT, linkedIssue: null }, COMMIT_CONTEXT]) {
      let prompt = ''
      await generateCommitMessageFromContext(
        context,
        templateParams,
        capturingTarget((value) => {
          prompt = value
        })
      )

      expect(prompt).toContain('Fixes #')
      expect(prompt).not.toContain('{linkedIssue}')
    }
  })

  // Why: a fixture-unique sentinel — a short number like 42 also appears in the
  // character counts that truncateDiffForPrompt/limitSection emit, so growing any
  // fixture past its limit would fail these guards for reasons unrelated to leakage.
  const BUILT_IN_PROMPT_SENTINEL_ISSUE = 987654
  const builtInPromptParams = {
    agentId: 'custom' as const,
    model: '',
    customAgentCommand: 'agent'
  }

  it('leaves the built-in commit prompt free of issue guidance', async () => {
    let prompt = ''
    await generateCommitMessageFromContext(
      { ...COMMIT_CONTEXT, linkedIssue: BUILT_IN_PROMPT_SENTINEL_ISSUE },
      builtInPromptParams,
      capturingTarget((value) => {
        prompt = value
      })
    )

    expect(prompt).not.toContain(String(BUILT_IN_PROMPT_SENTINEL_ISSUE))
    expect(prompt).not.toContain('linkedIssue')
  })

  it('includes the linked issue in the built-in pull-request prompt', async () => {
    let prompt = ''
    await generatePullRequestFieldsFromContext(
      {
        ...PULL_REQUEST_CONTEXT,
        linkedIssue: BUILT_IN_PROMPT_SENTINEL_ISSUE,
        provider: 'gitlab',
        linkedIssueDetails: {
          provider: 'gitlab',
          number: BUILT_IN_PROMPT_SENTINEL_ISSUE,
          title: 'Stop phantom polling',
          description: 'Avoid paths that cannot exist on this host.'
        }
      },
      builtInPromptParams,
      capturingTarget((value) => {
        prompt = value
      })
    )

    expect(prompt).toContain(`Linked GitLab issue: #${BUILT_IN_PROMPT_SENTINEL_ISSUE}`)
    expect(prompt).toContain(`Closes #${BUILT_IN_PROMPT_SENTINEL_ISSUE}`)
    expect(prompt).toContain(`Related to #${BUILT_IN_PROMPT_SENTINEL_ISSUE}`)
    expect(prompt).toContain('Stop phantom polling')
    expect(prompt).toContain('Avoid paths that cannot exist on this host.')
    expect(prompt).not.toContain('GitHub issue')
  })

  it('substitutes the linked issue into the pull-request prompt', async () => {
    let prompt = ''
    await generatePullRequestFieldsFromContext(
      { ...PULL_REQUEST_CONTEXT, linkedIssue: 7 },
      templateParams,
      capturingTarget((value) => {
        prompt = value
      })
    )

    expect(prompt).toContain('Fixes #7')
    expect(prompt).not.toContain('{linkedIssue}')
  })

  it('renders an empty pull-request issue when none resolves', async () => {
    let prompt = ''
    await generatePullRequestFieldsFromContext(
      PULL_REQUEST_CONTEXT,
      templateParams,
      capturingTarget((value) => {
        prompt = value
      })
    )

    expect(prompt).toContain('Fixes #')
    expect(prompt).not.toContain('{linkedIssue}')
  })

  it('leaves a hand-typed linkedIssue literal in branch-name templates', async () => {
    let prompt = ''
    await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      { ...templateParams, commandInputTemplate: '{basePrompt}\n\nIssue {linkedIssue}' },
      capturingTarget((value) => {
        prompt = value
      })
    )

    expect(prompt).toContain('Issue {linkedIssue}')
  })
})
