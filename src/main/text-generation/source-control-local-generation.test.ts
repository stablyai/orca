import { expect, it } from 'vitest'
import { planCommitMessageGeneration } from '../../shared/source-control/ai/generation/commit-message-plan'
import { createMockDiscoveryChild } from './commit-message-text-generation-test-harness'
import { runLocalPlanForAgent } from './source-control-local-generation'

it('keeps inherited OpenCode config under the text-generation tool policy', async () => {
  const planned = planCommitMessageGeneration({ agentId: 'opencode2', model: 'default' }, 'PROMPT')
  if (!planned.ok) {
    throw new Error(planned.error)
  }
  const child = createMockDiscoveryChild()
  const result = runLocalPlanForAgent({
    agentId: 'opencode2',
    plan: planned.plan,
    target: {
      kind: 'local',
      cwd: '/repo',
      env: { PATH: '/usr/bin', OPENCODE_CONFIG_CONTENT: '{"provider":{"p":{}}}' }
    },
    operation: 'conversation-name',
    spawnAgent: (input) => {
      expect(input.commandEnv?.OPENCODE_CONFIG_CONTENT).toBe(
        '{"provider":{"p":{}},"permission":{"*":"deny","read":"allow","grep":"allow","glob":"allow","list":"allow"}}'
      )
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          Buffer.from('{"type":"text","part":{"type":"text","text":"Name"}}\n')
        )
        child.emit('close', 0)
      })
      return child
    }
  })
  expect(await result).toMatchObject({ success: true })
})
