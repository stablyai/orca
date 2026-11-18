import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AUTOMATION_METHODS } from './automations/automations'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe("a bot's automation.update from a phone", () => {
  function setup() {
    const updateAutomation = vi.fn().mockResolvedValue({ id: 'auto-1', enabled: false })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: automation.update reads only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showAutomation: () => ({ id: 'auto-1', bot: { botId: 'bot-1' } }),
      updateAutomation,
      automationOwnerPrecondition: () => null
    } as unknown as OrcaRuntimeService
    return {
      updateAutomation,
      dispatcher: new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
    }
  }

  it.each([
    ['pauses it', { updates: { enabled: false } }],
    ['changes the prompt with the switch', { updates: { enabled: true, prompt: 'Do more' } }],
    ['changes the schedule', { updates: { rrule: 'FREQ=DAILY' } }],
    ['changes the agent', { updates: { agentId: 'codex' } }]
  ])('%s', async (_label, patch) => {
    const { updateAutomation, dispatcher } = setup()

    const response = await dispatcher.dispatch(
      makeRequest('automation.update', { id: 'auto-1', ...patch }),
      { callerScope: { kind: 'mobile' } }
    )

    expect(response).toMatchObject({ ok: true })
    expect(updateAutomation).toHaveBeenCalledWith('auto-1', patch.updates, expect.anything())
  })
})
