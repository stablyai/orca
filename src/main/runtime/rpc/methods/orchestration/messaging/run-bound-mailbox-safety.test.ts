import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const LEAD = 'tab_lead:22222222-2222-4222-9222-222222222222'
const OTHER = 'tab_other:33333333-3333-4333-8333-333333333333'

describe('Run-bound lead mailbox boundaries', () => {
  const h = createOrchestrationRpcHarness()
  let state: ReturnType<typeof h.setup>
  let dispatch: ReturnType<typeof createRootDispatch>
  let leadRun: ReturnType<typeof state.db.createRun>

  beforeEach(() => {
    state = h.setup()
    vi.mocked(state.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_lead' ? LEAD : handle === 'term_coord' ? h.coordinatorPaneKey : OTHER
    )
    const task = state.db.createTask({ spec: 'nested lead' })
    dispatch = createRootDispatch(state.db, task.id, 'term_lead', LEAD)
    leadRun = state.db.createRun({
      objective: 'child Run',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: LEAD
    })
  })
  afterEach(() => h.cleanup())

  function check(params: Record<string, unknown> = {}) {
    return h.call('orchestration.check', { terminal: 'term_lead', ...params }, state.ctx)
  }

  it('wakes a parked Run check for Dispatch mail sent after binding', async () => {
    const waiter = vi.spyOn(state.runtime, 'waitForMessage')
    const waiting = check({ wait: true, timeoutMs: 1_000 })
    await vi.waitFor(() =>
      expect(waiter).toHaveBeenCalledWith(`run:${leadRun.id}`, expect.anything())
    )
    await h.call(
      'orchestration.send',
      { from: 'term_coord', to: `dispatch:${dispatch.id}`, subject: 'wake up' },
      state.ctx
    )
    expect(await waiting).toMatchObject({ timedOut: false, messages: [{ subject: 'wake up' }] })
  })
})
