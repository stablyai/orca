import { describe, expect, it, vi } from 'vitest'
import { createMockDiscoveryChild } from './commit-message-text-generation-test-harness'
import { generateText } from './source-control-text-generation-requests'

describe('local OMP Mission generation', () => {
  it('writes the full planner prompt once to stdin and returns the subprocess JSON', async () => {
    const child = createMockDiscoveryChild()
    const spawnAgent = vi.fn().mockReturnValue(child)
    const prompt = `分析当前电脑的性能缺口\n${'Read-only context.\n'.repeat(1_000)}`
    const env = { OMP_PROFILE: 'configured-profile' }
    const result = generateText({
      prompt,
      params: { agentId: 'omp', model: 'must-not-override-user-model' },
      target: { kind: 'local', cwd: '/planner', env },
      operation: 'mission-plan',
      useAgentDefaultModel: true,
      spawnAgent
    })

    await vi.waitFor(() => expect(spawnAgent).toHaveBeenCalledOnce())
    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        binary: 'omp',
        cwd: '/planner',
        env,
        stdinMode: 'pipe',
        useCwdForNative: true
      })
    )
    const args = spawnAgent.mock.calls[0]?.[0].args
    expect(args).not.toContain('--model')
    expect(args).not.toContain('must-not-override-user-model')
    expect(args).not.toContain(prompt)
    expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith(prompt)
    child.stdout.emit('data', Buffer.from('{"mode":"single-agent"}\n'))
    child.emit('close', 0)

    await expect(result).resolves.toEqual({
      success: true,
      text: '{"mode":"single-agent"}',
      agentLabel: 'OMP'
    })
  })
})
