import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AUTOMATION_METHODS } from './automations/automations'

const ON = [{ id: 'on-1', source: 'slack', event: 'mentioned', in: ['C1'] }]
const CREATE = {
  name: 'Deploy pings',
  prompt: 'Answer it',
  agentId: 'claude',
  bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
  rrule: 'FREQ=DAILY;BYHOUR=0;BYMINUTE=0',
  dtstart: Date.UTC(9999, 0, 1)
}

function request(method: string, params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function setup() {
  const stub = {
    getRuntimeId: () => 'test-runtime',
    createAutomation: vi.fn().mockResolvedValue({ id: 'a1' }),
    updateAutomation: vi.fn().mockResolvedValue({ id: 'a1' })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: automation.create/update reach only these runtime methods.
  const runtime = stub as unknown as OrcaRuntimeService
  return { runtime, dispatcher: new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS }) }
}

describe('automation event triggers over RPC', () => {
  it('passes the events through', async () => {
    const { runtime, dispatcher } = setup()

    await dispatcher.dispatch(request('automation.create', { ...CREATE, on: ON }))
    await dispatcher.dispatch(request('automation.update', { id: 'a1', updates: { on: [] } }))

    expect(runtime.createAutomation).toHaveBeenCalledWith(expect.objectContaining({ on: ON }))
    expect(runtime.updateAutomation).toHaveBeenCalledWith('a1', { on: [] }, expect.anything())
  })

  it.each([
    ['an event it does not know', { event: 'pinged' }],
    ['a filter it cannot read', { from: 'members' }],
    ['a filter that is not text', { subject: 123 }]
  ])('refuses %s rather than widening the rule', async (_, change) => {
    const { runtime, dispatcher } = setup()
    await expect(
      dispatcher.dispatch(
        request('automation.create', { ...CREATE, on: [{ ...ON[0], ...change }] })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.createAutomation).not.toHaveBeenCalled()
  })
})
