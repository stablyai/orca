import {
  sourceShapedKimiOutput,
  realKimiOccupiedOutput
} from '../../shared/__fixtures__/kimi-generation-source-shaped'
import { describe, expect, it } from 'vitest'
import { generateBranchNameFromContext } from './commit-message-text-generation'

describe('generateBranchNameFromContext', () => {
  it.each(['custom', 'kimi'] as const)('%s branch slug', async (agentId) => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      {
        agentId,
        model: agentId === 'kimi' ? 'default' : '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout:
            agentId === 'kimi'
              ? sourceShapedKimiOutput('"Fix/Login Flow now please"')
              : '"Fix/Login Flow now please"\n',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: true,
      slug: 'fix-login-flow-now',
      agentLabel: agentId === 'kimi' ? 'Kimi' : 'agent'
    })
  })

  it('fails when remote agent output sanitizes to an empty branch slug', async () => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '!!! ___\n',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toMatchObject({
      success: false,
      error: 'Generated branch name was empty after sanitization.',
      failureOutput: { label: 'agent', exitCode: 0, stdout: '!!! ___', stderr: '' }
    })
  })

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

  it('does not persist stdout-only branch failure detail that may echo the prompt', async () => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Customer secret in the first prompt' },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'Customer secret in the first prompt',
          stderr: '',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toMatchObject({
      success: false,
      error: 'agent CLI command failed with code 1.',
      failureOutput: {
        label: 'agent',
        exitCode: 1,
        stdout: 'Customer secret in the first prompt',
        stderr: ''
      }
    })
  })

  it('describes a signal-terminated generator without a null exit code', async () => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.5'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '',
          stderr: 'Process killed by host',
          exitCode: null,
          timedOut: false
        })
      }
    )

    expect(result).toMatchObject({
      success: false,
      error: 'Pi CLI command was terminated before exiting: Process killed by host'
    })
  })

  it('keeps branch-name guidance first without dropping the output contract', async () => {
    let prompt = ''
    await generateBranchNameFromContext(
      { firstPrompt: 'Fix login flow' },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent',
        customPrompt: 'Prefer auth terminology.',
        commandInputTemplate: 'Prefer auth terminology.\n\n{basePrompt}'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (plan) => {
          prompt = plan.stdinPayload ?? ''
          return {
            stdout: 'fix-login-flow\n',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )

    expect(prompt.startsWith('Prefer auth terminology.')).toBe(true)
    expect(prompt).toContain('Prefer auth terminology.')
    expect(prompt).not.toContain('Additional user prompt:')
    expect(prompt).toContain('Generate a short git branch name')
    expect(prompt).toContain('Output ONLY the branch name on a single line')
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
