import { realKimiOccupiedOutput } from '../../shared/__fixtures__/kimi-generation-source-shaped'
import { describe, expect, it } from 'vitest'
import { generateBranchNameFromContext } from './commit-message-text-generation'

describe('generateBranchNameFromContext', () => {
  it.each(['pi', 'kimi'] as const)('%s failure diagnostics', async (agentId) => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      {
        agentId,
        model: agentId === 'kimi' ? 'default' : 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: agentId === 'kimi' ? realKimiOccupiedOutput : 'partial',
          stderr: 'No API key found for github-copilot.',
          exitCode: agentId === 'kimi' ? 4 : 1,
          timedOut: false
        })
      }
    )

    expect(result.success).toBe(false)
    if (result.success) {
      throw new Error('expected a failure result')
    }
    if (agentId === 'kimi') {
      expect(result.error).toMatch(/Kimi.*active.*Stop.*exit.*try again/)
    }
    expect(result.failureOutput).toEqual({
      label: agentId === 'kimi' ? 'Kimi' : 'Pi',
      exitCode: agentId === 'kimi' ? 4 : 1,
      stdout: agentId === 'kimi' ? realKimiOccupiedOutput : 'partial',
      stderr: 'No API key found for github-copilot.'
    })
  })

  it('reruns Copilot once on its default model when the plan hides the saved model', async () => {
    const calls: string[][] = []
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      { agentId: 'copilot', model: 'gpt-5.4', thinkingLevel: 'low' },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (plan) => {
          calls.push(plan.args)
          return calls.length === 1
            ? {
                stdout: '',
                stderr: 'Error: Model "gpt-5.4" from --model flag is not available.\n',
                exitCode: 1,
                timedOut: false
              }
            : { stdout: 'fix-login-flow\n', stderr: '', exitCode: 0, timedOut: false }
        }
      }
    )

    expect(result).toEqual({ success: true, slug: 'fix-login-flow', agentLabel: 'GitHub Copilot' })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(expect.arrayContaining(['--model', 'gpt-5.4', '--effort', 'low']))
    expect(calls[1]).toEqual(
      calls[0].filter((arg) => !['--model', 'gpt-5.4', '--effort', 'low'].includes(arg))
    )
  })
})
