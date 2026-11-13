import { describe, expect, it } from 'vitest'

import { generateCommitMessageFromContext } from '../commit-message-text-generation'

describe('generateCommitMessageFromContext', () => {
  it('sanitizes remote execution transport failures', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => {
          throw new Error('relay disconnected while reading /secret/repo')
        }
      }
    )

    expect(result).toEqual({
      success: false,
      error:
        'agent could not be reached on the remote PATH. Try again after the SSH connection recovers.'
    })
  })
})
