import { describe, expect, it, vi } from 'vitest'
import { generateTextFromPrompt } from './commit-message-text-generation'

describe('generateTextFromPrompt', () => {
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
      'mission-plan'
    )

    expect(result).toEqual({
      success: true,
      text: '{"mode":"single-agent"}',
      agentLabel: 'Pi'
    })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        binary: 'pi',
        label: 'Pi'
      }),
      '/repo',
      expect.any(Number),
      'mission-plan'
    )
  })
})
