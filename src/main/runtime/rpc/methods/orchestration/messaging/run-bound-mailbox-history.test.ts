import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const LEAD = 'tab_lead:22222222-2222-4222-9222-222222222222'
function deliveryId(result: unknown): string {
  if (
    typeof result === 'object' &&
    result &&
    'deliveryId' in result &&
    typeof result.deliveryId === 'string'
  ) {
    return result.deliveryId
  }
  throw new Error('Expected a Delivery')
}

describe('Run history after residual Dispatch acknowledgment', () => {
  const h = createOrchestrationRpcHarness()
  let state: ReturnType<typeof h.setup>
  beforeEach(() => {
    state = h.setup()
    vi.mocked(state.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_lead' ? LEAD : h.coordinatorPaneKey
    )
  })
  afterEach(() => h.cleanup())
  it.each([
    { mode: { all: true }, acknowledgeTogether: false },
    { mode: { all: true }, acknowledgeTogether: true },
    { mode: { unread: false }, acknowledgeTogether: false },
    { mode: { unread: false }, acknowledgeTogether: true }
  ])('shows Run history after old mail is read: %j', async ({ mode, acknowledgeTogether }) => {
    const task = state.db.createTask({ spec: 'nested lead' })
    const dispatch = createRootDispatch(state.db, task.id, 'term_lead', LEAD)
    const run = state.db.createRun({
      objective: 'child Run',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: LEAD
    })
    const old = state.db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      runId: dispatch.run_id,
      subject: 'old mail'
    })
    const check = (params = {}) =>
      h.call('orchestration.check', { terminal: 'term_lead', ...params }, state.ctx)
    expect(await check(mode)).toMatchObject({ runId: dispatch.run_id, messages: [{ id: old.id }] })
    expect(state.db.hasOutstandingMailboxDelivery(`dispatch:${dispatch.id}`)).toBe(false)
    const delivery = deliveryId(await check())
    if (!acknowledgeTogether) {
      await check({ ack: delivery })
    }
    const fresh = state.db.insertMessage({
      from: 'term_child',
      to: `run:${run.id}`,
      runId: run.id,
      subject: 'new mail'
    })
    expect(
      await check({ ...mode, ...(acknowledgeTogether ? { ack: delivery } : {}) })
    ).toMatchObject({ runId: run.id, messages: [{ id: fresh.id }] })
    expect(state.db.getMessageById(old.id)?.read).toBe(1)
    expect(state.db.getMessageById(fresh.id)?.read).toBe(0)
    expect(state.db.hasOutstandingMailboxDelivery(`dispatch:${dispatch.id}`)).toBe(false)
    expect(state.db.hasOutstandingMailboxDelivery(`run:${run.id}`)).toBe(false)
  })
})
