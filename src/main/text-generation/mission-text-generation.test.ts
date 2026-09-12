import { describe, expect, it, vi } from 'vitest'
import {
  generateCommitMessageFromContext,
  generateTextFromPrompt
} from './commit-message-text-generation'
import { generateText } from './source-control-text-generation-requests'
import type { CommitMessageGenerationTarget } from './source-control-text-generation-types'

describe('generateTextFromPrompt', () => {
  it.each(['remote', 'wsl'] as const)(
    'does not send local OMP isolation files to a %s execution host',
    async (host) => {
      const execute = vi.fn()
      const spawnAgent = vi.fn()
      const target: CommitMessageGenerationTarget =
        host === 'remote'
          ? { kind: 'remote', cwd: '/repo', execute, missingBinaryLocation: 'remote host' }
          : { kind: 'local', cwd: '/repo', wslDistro: 'Ubuntu' }
      const result = await generateText({
        prompt: 'Return JSON only.',
        params: { agentId: 'omp', model: '' },
        target,
        operation: 'mission-plan',
        useAgentDefaultModel: true,
        spawnAgent
      })

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('local controller host')
      })
      expect(execute).not.toHaveBeenCalled()
      expect(spawnAgent).not.toHaveBeenCalled()
    }
  )

  it('reuses the non-interactive agent runner and returns raw mission planner output', async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: '{"mode":"single-agent"}\n',
      stderr: '',
      exitCode: 0,
      timedOut: false
    })

    const result = await generateTextFromPrompt(
      'Return JSON only.',
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.4-mini'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        execute,
        missingBinaryLocation: 'remote host'
      },
      'mission-plan',
      { useAgentDefaultModel: true }
    )

    expect(result).toEqual({
      success: true,
      text: '{"mode":"single-agent"}',
      agentLabel: 'Pi'
    })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        binary: 'pi',
        label: 'Pi',
        args: expect.not.arrayContaining(['--model', 'github-copilot/gpt-5.4-mini'])
      }),
      '/repo',
      expect.any(Number),
      'mission-plan'
    )
  })

  it('does not enable OMP for Source Control AI as a side effect of Mission support', async () => {
    const execute = vi.fn()
    const result = await generateCommitMessageFromContext(
      { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' },
      { agentId: 'omp', model: '' },
      { kind: 'remote', cwd: '/repo', execute, missingBinaryLocation: 'remote host' }
    )

    expect(result).toEqual({
      success: false,
      error: 'Agent "omp" does not support AI commit messages.'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects an invalid OMP command override without launching a process', async () => {
    const spawnAgent = vi.fn()
    const result = await generateText({
      prompt: 'Return JSON only.',
      params: { agentId: 'omp', model: '', agentCommandOverride: '"unfinished' },
      target: { kind: 'local', cwd: '/repo' },
      operation: 'mission-plan',
      useAgentDefaultModel: true,
      spawnAgent
    })

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('invalid') })
    expect(spawnAgent).not.toHaveBeenCalled()
  })
})
