import { describe, expect, it } from 'vitest'
import {
  generateBranchNameFromContext,
  generateCommitMessageFromContext
} from '../commit-message-text-generation'

describe('commit-message generation regressions', () => {
  it('keeps bounded diagnostic captures out of commit-message results', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M src/policy.ts',
        stagedPatch: '+change'
      },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      {
        kind: 'remote',
        cwd: '/remote/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'prompt echoed from /Users/private/source/repo',
          stderr: 'failed reading /Users/private/source/repo/.env',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toMatchObject({
      success: false,
      error: 'agent CLI command failed with code 1: failed reading [path]',
      canceled: undefined
    })
    expect(JSON.stringify(result)).not.toContain('/Users/private')
    expect(result).not.toHaveProperty('failureOutput')
  })

  it('fills the {{firstPrompt}} branch-name template with the task after harness envelopes', async () => {
    const plans: string[] = []
    await generateBranchNameFromContext(
      { firstPrompt: '<hook_result hook_event="UserPromptSubmit">{}</hook_result>\nFix CI config' },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent',
        commandInputTemplate: '{{firstPrompt}}'
      },
      {
        kind: 'remote',
        cwd: '/remote/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (plan) => {
          plans.push(JSON.stringify(plan))
          return { stdout: 'fix-ci-config', stderr: '', exitCode: 0, timedOut: false }
        }
      }
    )

    expect(plans.join('\n')).toContain('Fix CI config')
    expect(plans.join('\n')).not.toContain('hook_result')
  })
})
