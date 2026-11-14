import { describe, expect, it } from 'vitest'
import { generateCommitMessageFromContext } from '../commit-message-text-generation'

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
})
