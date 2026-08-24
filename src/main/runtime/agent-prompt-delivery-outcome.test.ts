import { describe, expect, it } from 'vitest'
import {
  AgentPromptDeliveryUnknownError,
  agentPromptDeliveryBecameUnknown,
  isAgentPromptDeliveryUnknownError
} from './agent-prompt-delivery-outcome'

describe('agent prompt delivery outcome', () => {
  it('exposes an operation_unknown receipt with the causal failure', () => {
    const error = agentPromptDeliveryBecameUnknown(new Error('agent_prompt_stalled'))

    expect(error).toMatchObject({
      code: 'operation_unknown',
      data: { operation: 'agent_prompt_delivery', reason: 'agent_prompt_stalled' }
    })
    expect(error.message).toContain('agent_prompt_stalled')
  })

  it('preserves an existing unknown outcome', () => {
    const error = new AgentPromptDeliveryUnknownError('agent_prompt_not_ready')

    expect(agentPromptDeliveryBecameUnknown(error)).toBe(error)
    expect(isAgentPromptDeliveryUnknownError(error)).toBe(true)
  })
})
