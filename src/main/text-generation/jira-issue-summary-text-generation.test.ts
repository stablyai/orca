import { describe, expect, it } from 'vitest'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import { generateJiraIssueSummaryFromContext } from './jira-issue-summary-text-generation'

function remoteTarget(execute: (plan: CommitMessagePlan) => Promise<string>) {
  return {
    kind: 'remote' as const,
    cwd: '/home/user',
    missingBinaryLocation: 'remote PATH',
    execute: async (plan: CommitMessagePlan) => ({
      stdout: await execute(plan),
      stderr: '',
      exitCode: 0,
      timedOut: false
    })
  }
}

describe('generateJiraIssueSummaryFromContext', () => {
  it('sanitizes agent output into a single-line summary', async () => {
    const result = await generateJiraIssueSummaryFromContext(
      { description: 'Login crashes when retried offline.' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      remoteTarget(async () => '"Fix offline login retry crash"\nextra commentary')
    )

    expect(result).toEqual({
      success: true,
      summary: 'Fix offline login retry crash',
      agentLabel: 'agent'
    })
  })

  it('sends its own Jira prompt and ignores source-control templates and instructions', async () => {
    let prompt = ''
    await generateJiraIssueSummaryFromContext(
      {
        description: 'Crash on save',
        projectName: 'Mobile App',
        issueTypeName: 'Bug'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent',
        customPrompt: 'Prefer kebab-case names.',
        commandInputTemplate: 'Prefer kebab-case names.\n\n{basePrompt}'
      },
      remoteTarget(async (plan) => {
        prompt = plan.stdinPayload ?? ''
        return 'Fix crash on save'
      })
    )

    expect(prompt).toContain('Generate a concise Jira issue summary')
    expect(prompt).toContain('Project: Mobile App')
    expect(prompt).toContain('Issue type: Bug')
    expect(prompt).toContain('Crash on save')
    expect(prompt).not.toContain('kebab-case')
  })

  it('fails when the output sanitizes to an empty summary', async () => {
    const result = await generateJiraIssueSummaryFromContext(
      { description: 'Crash on save' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      remoteTarget(async () => '""\n')
    )

    expect(result).toEqual({
      success: false,
      error: 'Generated summary was empty after sanitization.'
    })
  })

  it('propagates agent failures', async () => {
    const result = await generateJiraIssueSummaryFromContext(
      { description: 'Crash on save' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      {
        kind: 'remote',
        cwd: '/home/user',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: 'No API key found.',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toMatchObject({
      success: false,
      error: 'agent CLI command failed with code 1: No API key found.'
    })
  })
})
