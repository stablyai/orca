import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AUTOMATION_METHODS } from './automations/automations'

const CREATE = {
  name: 'Morning',
  prompt: 'Summarize',
  agentId: 'claude',
  workspaceMode: 'new_per_run',
  timezone: 'Europe/London',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: 1
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('automation writes from a phone', () => {
  function setup() {
    const createAutomation = vi.fn().mockResolvedValue({ id: 'auto-1' })
    const updateAutomation = vi.fn().mockResolvedValue({ id: 'auto-1', enabled: false })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Automation create and update read only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showAutomation: () => ({ id: 'auto-1', bot: { botId: 'bot-1' } }),
      createAutomation,
      updateAutomation,
      automationOwnerPrecondition: () => null
    } as unknown as OrcaRuntimeService
    return {
      createAutomation,
      updateAutomation,
      dispatcher: new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
    }
  }

  it('passes changes from a mobile edit through to the runtime', async () => {
    const { updateAutomation, dispatcher } = setup()
    const updates = {
      enabled: false,
      prompt: 'Do more',
      agentId: 'codex',
      timezone: 'Asia/Tokyo',
      timezoneExplicit: true,
      rrule: 'FREQ=DAILY'
    }

    const response = await dispatcher.dispatch(
      makeRequest('automation.update', { id: 'auto-1', updates }),
      { callerScope: { kind: 'mobile' } }
    )

    expect(response).toMatchObject({ ok: true })
    expect(updateAutomation).toHaveBeenCalledWith('auto-1', updates, expect.anything())
  })

  it('preserves whether a mobile create explicitly chose its timezone', async () => {
    const { createAutomation, dispatcher } = setup()
    const scope = { callerScope: { kind: 'mobile' as const } }

    const older = await dispatcher.dispatch(makeRequest('automation.create', CREATE), scope)
    const named = await dispatcher.dispatch(
      makeRequest('automation.create', { ...CREATE, timezoneExplicit: true }),
      scope
    )

    expect(older).toMatchObject({ ok: true })
    expect(named).toMatchObject({ ok: true })
    expect(createAutomation.mock.calls[0]?.[0]).not.toHaveProperty('timezoneExplicit')
    expect(createAutomation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ timezone: 'Europe/London', timezoneExplicit: true })
    )
  })
})
